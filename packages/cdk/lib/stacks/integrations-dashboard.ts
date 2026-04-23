/**
 * Dashboard Fargate relay + relay-proxy Lambda wiring helper.
 *
 * Lives in its own file (mirroring `integrations-notion.ts`) so the main
 * `dashboard-stack.ts` stays focused on the Lambda + EventBridge + IAM pieces.
 *
 * Composes (per RESEARCH §13 Option B — Lambda Function URL wrapper):
 *  - ECS Fargate task definition (ARM64, 256 CPU / 512 MB) running
 *    `services/dashboard-listen-relay/Dockerfile` (built via
 *    `ContainerImage.fromAsset`).
 *  - FargateService on the existing `kos-cluster`, desiredCount = 1, in
 *    private isolated subnets (no internet egress needed).
 *  - Internal NetworkLoadBalancer (scheme=internal) fronting the task on :8080.
 *  - relay-proxy Lambda (`services/dashboard-listen-relay/src/proxy.ts`) —
 *    VPC-attached, forwards SigV4-authed HTTP calls from Vercel to the NLB's
 *    private DNS name.
 *  - `/healthz` target-group health check.
 *  - CloudWatch log group `/ecs/dashboard-listen-relay` with 30-day retention.
 *
 * Cost (RESEARCH §13 Option B): ~$10/month all-in — $5 Fargate + $0.20 NLB +
 * ~$3 Lambda (single-user traffic) + ~$2 log storage.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  FargateTaskDefinition,
  ContainerImage,
  AwsLogDriver,
  FargateService,
  CpuArchitecture,
  OperatingSystemFamily,
  type ICluster,
} from 'aws-cdk-lib/aws-ecs';
import {
  NetworkLoadBalancer,
  NetworkTargetGroup,
  Protocol,
  TargetType,
  NetworkListener,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RetentionDays, LogGroup } from 'aws-cdk-lib/aws-logs';
import {
  SubnetType,
  SecurityGroup,
  Port,
  type IVpc,
  type ISecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Stack } from 'aws-cdk-lib';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface DashboardRelayProps {
  vpc: IVpc;
  cluster: ICluster;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  rdsProxySecurityGroup: ISecurityGroup;
}

export interface DashboardRelayWiring {
  /** relay-proxy Lambda ARN — used by the IAM caller policy. */
  relayProxyFunctionArn: string;
  /** Function URL (https://...) the Vercel SSE handler calls. */
  relayProxyUrl: string;
  /** ECS service (exposed for tests + cross-stack references). */
  service: FargateService;
  /** Internal NLB (exposed so tests can assert scheme=internal). */
  nlb: NetworkLoadBalancer;
}

export function buildRelayStack(
  scope: Construct,
  props: DashboardRelayProps,
): DashboardRelayWiring {
  const stack = Stack.of(scope);

  // --- Log group ---------------------------------------------------------
  const logGroup = new LogGroup(scope, 'RelayLogGroup', {
    logGroupName: '/ecs/dashboard-listen-relay',
    retention: RetentionDays.ONE_MONTH, // 30-day retention (CLAUDE.md cost rule)
    removalPolicy: RemovalPolicy.DESTROY,
  });

  // --- Task definition (0.25 vCPU / 0.5 GB ARM64 per RESEARCH §13) -------
  const taskDef = new FargateTaskDefinition(scope, 'RelayTaskDef', {
    cpu: 256,
    memoryLimitMiB: 512,
    runtimePlatform: {
      cpuArchitecture: CpuArchitecture.ARM64,
      operatingSystemFamily: OperatingSystemFamily.LINUX,
    },
  });

  taskDef.addContainer('Relay', {
    image: ContainerImage.fromAsset(REPO_ROOT, {
      // Build from repo root so the Dockerfile can COPY pnpm-workspace.yaml,
      // packages/contracts, and services/dashboard-listen-relay during the
      // multi-stage build.
      file: 'services/dashboard-listen-relay/Dockerfile',
      // Build for linux/arm64 even from x86_64 dev machines (Docker buildx).
      platform: Platform.LINUX_ARM64,
      exclude: [
        '**/node_modules',
        '.next',
        'apps',
        '**/cdk.out',
        '**/cdk.out.dashboard',
        '.claude',
        '.planning',
        '.git',
        'dist',
        'tmp-deploy',
        '*.log',
      ],
    }),
    logging: new AwsLogDriver({ streamPrefix: 'relay', logGroup }),
    environment: {
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      AWS_REGION: stack.region,
      RDS_USER: 'dashboard_relay',
      RDS_DATABASE: 'kos',
      PORT: '8080',
      TZ: 'UTC',
    },
    portMappings: [{ containerPort: 8080 }],
    healthCheck: {
      command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/healthz || exit 1'],
      interval: Duration.seconds(30),
      retries: 3,
      timeout: Duration.seconds(3),
      startPeriod: Duration.seconds(5),
    },
  });

  // IAM — task role allows `rds-db:connect` as the `dashboard_relay` user.
  // Grants on pg_notify / LISTEN are enforced at the Postgres role level
  // (Plan 05 schema-push migration). Lambda role has no DB privileges beyond
  // this connection signal.
  taskDef.taskRole.addToPrincipalPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/dashboard_relay`,
      ],
    }),
  );

  // --- Security groups ---------------------------------------------------
  const relaySg = new SecurityGroup(scope, 'RelaySG', {
    vpc: props.vpc,
    description: 'dashboard-listen-relay Fargate task + relay-proxy Lambda egress SG',
    allowAllOutbound: true,
  });
  // Ingress: relay-proxy Lambda -> NLB -> Fargate task on :8080.
  relaySg.addIngressRule(
    relaySg,
    Port.tcp(8080),
    'relay-proxy Lambda -> Fargate task (self-referencing)',
  );
  // Fargate relay -> RDS Proxy :5432 is allowed by DataStack's
  // `allowFromAnyIpv4(5432)` on the RDS Proxy SG — IAM auth is the gate
  // (same pattern as notion-indexer in Phase 1). Adding an explicit ingress
  // rule here would create a DashboardStack -> DataStack dependency cycle
  // via SecurityGroup.GroupId tokens.

  // --- Fargate service ---------------------------------------------------
  // desiredCount: 1 per D-24 (singleton task; brief downtime on deploy is
  // acceptable for single-user). maxHealthy 100 + minHealthy 0 = rolling
  // replace one task at a time.
  const service = new FargateService(scope, 'RelayService', {
    cluster: props.cluster,
    taskDefinition: taskDef,
    desiredCount: 1,
    maxHealthyPercent: 100,
    minHealthyPercent: 0,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    securityGroups: [relaySg],
    assignPublicIp: false,
    platformVersion: undefined, // accept default LATEST (1.4.0 effectively)
  });

  // --- Internal NLB ------------------------------------------------------
  const nlb = new NetworkLoadBalancer(scope, 'RelayNlb', {
    vpc: props.vpc,
    internetFacing: false,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    crossZoneEnabled: true,
  });

  const tg = new NetworkTargetGroup(scope, 'RelayTg', {
    vpc: props.vpc,
    port: 8080,
    protocol: Protocol.TCP,
    targetType: TargetType.IP,
    // ECS awsvpc tasks register by ENI IP; target health via HTTP /healthz.
    healthCheck: {
      protocol: Protocol.HTTP,
      path: '/healthz',
      port: '8080',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
      interval: Duration.seconds(30),
      timeout: Duration.seconds(6),
    },
    deregistrationDelay: Duration.seconds(5),
  });
  // Wire ECS -> target group.
  service.attachToNetworkTargetGroup(tg);

  new NetworkListener(scope, 'RelayListener', {
    loadBalancer: nlb,
    port: 8080,
    protocol: Protocol.TCP,
    defaultTargetGroups: [tg],
  });

  // --- relay-proxy Lambda (Option B ingress) -----------------------------
  // Node 22 ARM64, VPC-attached, forwards HTTP calls to the internal NLB's
  // private DNS name. Reuses the same SigV4 library (service=lambda) on the
  // Vercel side as dashboard-api.
  const proxyFn = new KosLambda(scope, 'RelayProxy', {
    entry: path.join(REPO_ROOT, 'services', 'dashboard-listen-relay', 'src', 'proxy.ts'),
    timeout: Duration.seconds(30),
    memory: 256,
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [relaySg],
    environment: {
      RELAY_INTERNAL_URL: `http://${nlb.loadBalancerDnsName}:8080`,
    },
  });

  const proxyUrl = proxyFn.addFunctionUrl({
    authType: FunctionUrlAuthType.AWS_IAM,
    invokeMode: InvokeMode.BUFFERED,
  });

  return {
    relayProxyFunctionArn: proxyFn.functionArn,
    relayProxyUrl: proxyUrl.url,
    service,
    nlb,
  };
}
