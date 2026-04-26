/**
 * EmailEngine Fargate + ElastiCache Serverless Redis + 2 Lambdas wiring helper
 * (Phase 4 / Plan 04-03, CAP-07 + INF-06).
 *
 * Composes:
 *  - ElastiCache Serverless Redis (`kos-emailengine-redis`, engine redis 7+)
 *    in PRIVATE_WITH_EGRESS subnets, SG-restricted to ingress on :6379 from
 *    the EmailEngine task SG only.
 *  - Single Fargate task (ARM64, 1 vCPU / 2 GB) running
 *    `postalsys/emailengine:latest` on the existing kos-cluster.
 *    `desiredCount=1`, `minHealthyPercent=0`, `maxHealthyPercent=100` per
 *    Plan 04-03: EmailEngine forbids horizontal scaling (single Redis-backed
 *    state store); deploy briefly takes the task offline.
 *  - AWS Cloud Map private DNS namespace `kos-internal.local` with the EE
 *    service registered as `emailengine.kos-internal.local:3000`. The admin
 *    Lambda resolves the EE REST endpoint via this internal DNS name.
 *  - emailengine-webhook Lambda + Function URL (authType=NONE — X-EE-Secret
 *    is the auth boundary; same pattern as iOS webhook). Outside the VPC.
 *  - emailengine-admin Lambda + Function URL (authType=AWS_IAM — operator
 *    invocations sign with SigV4). VPC-attached so it can reach the
 *    EmailEngine REST endpoint at `emailengine.kos-internal.local:3000`.
 *  - CloudWatch log group `/ecs/emailengine` (30-day retention) plus a
 *    metric filter on `"auth failure"` lines for the Plan 04-03 Gate-3
 *    7-day soak criterion.
 *
 * NEVER scale EmailEngine horizontally:
 *   EmailEngine cannot tolerate multiple processes sharing the same Redis
 *   state. Setting `desiredCount > 1` causes phantom IMAP IDLE reconnect
 *   storms + duplicate webhook deliveries. The construct hard-codes
 *   `desiredCount=1` and the test asserts the value. If you ever need to
 *   change this, you are wrong — re-read postalsys.com/emailengine docs.
 *
 * Costs (~$45/mo steady state):
 *   - Fargate (1 vCPU + 2 GB ARM64, 24/7) ~ $35.91/mo
 *   - ElastiCache Serverless Redis (idle) ~ $10/mo
 *   - License (~$99/yr amortized) ~ $8/mo
 *   - 2 Lambdas + Function URLs ~ <$1/mo
 *
 * Operator runbook: .planning/phases/04-email-pipeline-ios-capture/
 *                   04-EMAILENGINE-OPERATOR-RUNBOOK.md
 *
 * Activation gate:
 *   Wired into IntegrationsStack only when `enableEmailEngine === true`
 *   AND all 5 EmailEngine secrets are passed in. Until then the helper is
 *   a no-op so existing deploys + tests do not synthesise a Fargate service
 *   that the operator hasn't seeded credentials for. Deploying without a
 *   real license + Gmail app passwords would burn the 14-day EE trial
 *   silently and crash the IMAP IDLE loop on cold start.
 */
import { Duration, RemovalPolicy, CfnOutput, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  FargateTaskDefinition,
  FargateService,
  ContainerImage,
  AwsLogDriver,
  CpuArchitecture,
  OperatingSystemFamily,
  Secret as EcsSecret,
  type ICluster,
} from 'aws-cdk-lib/aws-ecs';
import {
  SecurityGroup,
  Port,
  SubnetType,
  type IVpc,
} from 'aws-cdk-lib/aws-ec2';
import {
  CfnServerlessCache,
  CfnSubnetGroup,
} from 'aws-cdk-lib/aws-elasticache';
import { LogGroup, RetentionDays, MetricFilter } from 'aws-cdk-lib/aws-logs';
import { PrivateDnsNamespace } from 'aws-cdk-lib/aws-servicediscovery';
import {
  FunctionUrlAuthType,
  InvokeMode,
} from 'aws-cdk-lib/aws-lambda';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireEmailEngineProps {
  vpc: IVpc;
  /** The shared kos-cluster Fargate cluster (DataStack.ecsCluster). */
  cluster: ICluster;
  /** EventBridge `kos.capture` bus — webhook Lambda emits capture.received. */
  captureBus: EventBus;
  /** kos/emailengine-license-key — passed to the EE container. */
  licenseSecret: ISecret;
  /** kos/emailengine-imap-kevin-elzarka — JSON {email, app_password}. */
  imapElzarkaSecret: ISecret;
  /** kos/emailengine-imap-kevin-taleforge — JSON {email, app_password}. */
  imapTaleforgeSecret: ISecret;
  /** kos/emailengine-webhook-secret — X-EE-Secret value EE sends to webhook. */
  webhookSecret: ISecret;
  /** kos/emailengine-api-key — Bearer token EE accepts on its REST API. */
  apiKeySecret: ISecret;
  /** Owner UUID propagated to the Lambdas (with-timeout-retry dead-letter). */
  kevinOwnerId?: string;
  /** Optional Sentry DSN secret — wired into both Lambdas if provided. */
  sentryDsnSecret?: ISecret;
  /** Optional Langfuse public key secret — Lambda env. */
  langfusePublicKeySecret?: ISecret;
  /** Optional Langfuse secret key secret — Lambda env. */
  langfuseSecretKeySecret?: ISecret;
}

export interface EmailEngineWiring {
  webhookFunction: KosLambda;
  webhookUrl: string;
  adminFunction: KosLambda;
  adminUrl: string;
  service: FargateService;
  redis: CfnServerlessCache;
  emailEngineSg: SecurityGroup;
}

export function wireEmailEngine(
  scope: Construct,
  props: WireEmailEngineProps,
): EmailEngineWiring {
  const stack = Stack.of(scope);

  // --- Log group + metric filter ----------------------------------------
  const logGroup = new LogGroup(scope, 'EmailEngineLogGroup', {
    logGroupName: '/ecs/emailengine',
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  // Plan 04-03 Gate 3 criterion: 7 consecutive days of zero IMAP auth
  // failures. This filter exposes a `KOS::EmailEngineAuthFailures` metric
  // that the operator queries via `aws cloudwatch get-metric-statistics`.
  new MetricFilter(scope, 'EmailEngineAuthFailureFilter', {
    logGroup,
    filterName: 'emailengine-auth-failures',
    filterPattern: { logPatternString: '"auth failure"' },
    metricNamespace: 'KOS',
    metricName: 'EmailEngineAuthFailures',
    metricValue: '1',
    defaultValue: 0,
  });

  // --- Security groups --------------------------------------------------
  const emailEngineSg = new SecurityGroup(scope, 'EmailEngineSg', {
    vpc: props.vpc,
    description: 'EmailEngine Fargate task egress + ingress',
    allowAllOutbound: true, // needs reach to Gmail IMAP :993, SecretsManager, etc.
  });
  const redisSg = new SecurityGroup(scope, 'EmailEngineRedisSg', {
    vpc: props.vpc,
    description: 'ElastiCache Serverless Redis for EmailEngine',
    allowAllOutbound: false,
  });
  // Redis ingress on :6379 from EmailEngine task SG ONLY (T-04-EE-03).
  redisSg.addIngressRule(
    emailEngineSg,
    Port.tcp(6379),
    'EmailEngine Fargate task to Redis',
  );

  // --- ElastiCache Serverless Redis -------------------------------------
  // PRIVATE_WITH_EGRESS subnets so the redis can reach AWS service planes
  // (KMS for at-rest encryption, etc.). Cache usage limits intentionally
  // minimal — KOS is single-user; EmailEngine state for 2 inboxes fits in
  // <100 MB. The 1 GB cap leaves headroom for unexpected spikes.
  const subnetIds = props.vpc
    .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
    .subnetIds;
  const redisSubnetGroup = new CfnSubnetGroup(
    scope,
    'EmailEngineRedisSubnetGroup',
    {
      cacheSubnetGroupName: 'kos-emailengine-redis-subnets',
      description: 'Subnets for kos-emailengine-redis (Plan 04-03)',
      subnetIds,
    },
  );
  const redis = new CfnServerlessCache(scope, 'EmailEngineRedis', {
    serverlessCacheName: 'kos-emailengine-redis',
    engine: 'redis',
    majorEngineVersion: '7',
    securityGroupIds: [redisSg.securityGroupId],
    subnetIds,
    cacheUsageLimits: {
      dataStorage: { unit: 'GB', maximum: 1 },
      ecpuPerSecond: { maximum: 1000 },
    },
    description: 'EmailEngine state store (single-user; ~$10/mo idle).',
  });
  redis.addDependency(redisSubnetGroup);

  // --- Cloud Map private DNS namespace ----------------------------------
  // The admin Lambda resolves the EE REST endpoint via
  // `emailengine.kos-internal.local:3000`. Using a fresh PrivateDnsNamespace
  // (rather than the cluster's defaultCloudMapNamespace) keeps this helper
  // self-contained and re-deployable.
  const namespace = new PrivateDnsNamespace(
    scope,
    'EmailEngineInternalDns',
    {
      name: 'kos-internal.local',
      vpc: props.vpc,
      description: 'Internal DNS namespace for KOS Fargate services (Plan 04-03).',
    },
  );

  // --- emailengine-webhook Lambda (created BEFORE the EE container so we
  //     can reference its Function URL in the EE env) -----------------------
  // Outside the VPC: same shape as ios-webhook. X-EE-Secret in the header
  // IS the auth boundary; the URL is internet-reachable but rejects every
  // request without a constant-time-equal secret.
  const webhookFn = new KosLambda(scope, 'EmailEngineWebhook', {
    entry: svcEntry('emailengine-webhook'),
    timeout: Duration.seconds(15),
    memory: 512,
    environment: {
      EE_WEBHOOK_SECRET_ARN: props.webhookSecret.secretArn,
      KEVIN_OWNER_ID: props.kevinOwnerId ?? '',
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
      ...(props.langfusePublicKeySecret
        ? {
            LANGFUSE_PUBLIC_KEY_SECRET_ARN:
              props.langfusePublicKeySecret.secretArn,
          }
        : {}),
      ...(props.langfuseSecretKeySecret
        ? {
            LANGFUSE_SECRET_KEY_SECRET_ARN:
              props.langfuseSecretKeySecret.secretArn,
          }
        : {}),
    },
  });
  props.webhookSecret.grantRead(webhookFn);
  props.captureBus.grantPutEventsTo(webhookFn);
  props.sentryDsnSecret?.grantRead(webhookFn);
  props.langfusePublicKeySecret?.grantRead(webhookFn);
  props.langfuseSecretKeySecret?.grantRead(webhookFn);
  const webhookFnUrl = webhookFn.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
  });

  // --- Fargate task definition + container ------------------------------
  const taskDef = new FargateTaskDefinition(scope, 'EmailEngineTaskDef', {
    cpu: 1024,
    memoryLimitMiB: 2048,
    runtimePlatform: {
      cpuArchitecture: CpuArchitecture.ARM64,
      operatingSystemFamily: OperatingSystemFamily.LINUX,
    },
  });

  taskDef.addContainer('EmailEngine', {
    image: ContainerImage.fromRegistry('postalsys/emailengine:latest'),
    logging: new AwsLogDriver({ streamPrefix: 'emailengine', logGroup }),
    environment: {
      EENGINE_PORT: '3000',
      EENGINE_WORKERS: '4',
      EENGINE_LOG_LEVEL: 'info',
      EENGINE_REDIS: `redis://${redis.attrEndpointAddress}:6379`,
      // Push notifications back to our Lambda.
      EENGINE_NOTIFY_URL: webhookFnUrl.url,
      TZ: 'UTC',
    },
    secrets: {
      // Sensitive values arrive via the SSM/SecretsManager ECS integration —
      // CloudFormation never sees the literal strings.
      EENGINE_LICENSE: EcsSecret.fromSecretsManager(props.licenseSecret),
      EENGINE_API_KEY: EcsSecret.fromSecretsManager(props.apiKeySecret),
      // EmailEngine forwards this header on every webhook POST; the Lambda
      // verifies it via timingSafeEqual against the same secret.
      EENGINE_NOTIFY_HEADERS_X_EE_SECRET:
        EcsSecret.fromSecretsManager(props.webhookSecret),
    },
    portMappings: [{ containerPort: 3000 }],
    healthCheck: {
      command: [
        'CMD-SHELL',
        'wget -qO- http://127.0.0.1:3000/v1/health || exit 1',
      ],
      interval: Duration.seconds(30),
      retries: 3,
      timeout: Duration.seconds(5),
      startPeriod: Duration.seconds(20),
    },
  });

  // --- Fargate service --------------------------------------------------
  // CRITICAL: desiredCount=1 — EmailEngine FORBIDS horizontal scaling.
  // minHealthy=0 + maxHealthy=100 means rolling deploy briefly takes the
  // task offline. For a single user receiving emails this is acceptable;
  // the IMAP IDLE state survives via Redis so reconnection on the new task
  // is automatic.
  const service = new FargateService(scope, 'EmailEngineService', {
    cluster: props.cluster,
    taskDefinition: taskDef,
    desiredCount: 1,
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [emailEngineSg],
    assignPublicIp: false,
    cloudMapOptions: {
      name: 'emailengine',
      cloudMapNamespace: namespace,
    },
  });

  // --- emailengine-admin Lambda -----------------------------------------
  // VPC-attached because it calls EE REST at the internal Cloud Map DNS
  // name (`http://emailengine.kos-internal.local:3000`). Function URL auth
  // is AWS_IAM — only operator IAM creds (Kevin or a bastion role) can
  // invoke it.
  const eeRestUrl = `http://emailengine.${namespace.namespaceName}:3000`;
  const adminFn = new KosLambda(scope, 'EmailEngineAdmin', {
    entry: svcEntry('emailengine-admin'),
    timeout: Duration.seconds(120),
    memory: 512,
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [emailEngineSg],
    environment: {
      EE_REST_URL: eeRestUrl,
      EE_API_KEY_SECRET_ARN: props.apiKeySecret.secretArn,
      KEVIN_OWNER_ID: props.kevinOwnerId ?? '',
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
    },
  });
  props.apiKeySecret.grantRead(adminFn);
  props.imapElzarkaSecret.grantRead(adminFn);
  props.imapTaleforgeSecret.grantRead(adminFn);
  props.sentryDsnSecret?.grantRead(adminFn);
  const adminFnUrl = adminFn.addFunctionUrl({
    authType: FunctionUrlAuthType.AWS_IAM,
    invokeMode: InvokeMode.BUFFERED,
  });

  // --- Outputs ----------------------------------------------------------
  new CfnOutput(scope, 'EmailEngineWebhookUrl', {
    value: webhookFnUrl.url,
    exportName: `${stack.stackName}-EmailEngineWebhookUrl`,
    description:
      'Function URL EmailEngine POSTs messageNew events to (X-EE-Secret guarded).',
  });
  new CfnOutput(scope, 'EmailEngineAdminUrl', {
    value: adminFnUrl.url,
    exportName: `${stack.stackName}-EmailEngineAdminUrl`,
    description:
      'Operator-only Function URL (AWS_IAM auth) for register/unregister account.',
  });
  new CfnOutput(scope, 'EmailEngineRedisEndpoint', {
    value: redis.attrEndpointAddress,
    exportName: `${stack.stackName}-EmailEngineRedisEndpoint`,
    description: 'ElastiCache Serverless Redis endpoint for EmailEngine.',
  });

  return {
    webhookFunction: webhookFn,
    webhookUrl: webhookFnUrl.url,
    adminFunction: adminFn,
    adminUrl: adminFnUrl.url,
    service,
    redis,
    emailEngineSg,
  };
}
