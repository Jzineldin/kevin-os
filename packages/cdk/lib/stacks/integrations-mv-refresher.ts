/**
 * MV refresher pipeline wiring helper (Phase 6 Plan 06-04).
 *
 * Surface: `wireMvRefresher` — installs the entity-timeline-refresher
 * Lambda + EventBridge Scheduler entry (`rate(5 minutes)` Europe/Stockholm)
 * + IAM grants. Mirrors `integrations-granola.ts` exactly: same
 * scheduler-role pattern (NO `aws:SourceArn` condition per the Phase 1
 * Plan 02-04 retro), same `KosLambda` construct, same VPC config helper.
 *
 * The refresher is intentionally LLM-free + no Bedrock grants — its only
 * job is to issue `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline`
 * against the RDS Proxy. IAM scope is exactly:
 *   - rds-db:connect on the RDS Proxy DBI (kos_agent_writer user)
 *   - secretsmanager:GetSecretValue on Sentry + Langfuse (D-28 instrumentation)
 *
 * Reference:
 *   .planning/phases/06-granola-semantic-memory/06-04-PLAN.md
 *   .planning/phases/06-granola-semantic-memory/06-CONTEXT.md (D-25)
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireMvRefresherProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` — from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  scheduleGroupName: string;
  /**
   * Optional re-use of the EventBridge Scheduler role created by
   * `wireNotionIntegrations` / `wireGranolaPipeline`. If absent, a new role
   * is created scoped to the refresher only.
   */
  schedulerRole?: Role;
  /**
   * Phase 6 D-28 instrumentation. Optional so synth still works in
   * minimal-prop test fixtures (the runtime degrades gracefully when env
   * vars are unset — see services/_shared/sentry.ts + tracing.ts).
   */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  /** RDS IAM user for `rds-db:connect`. Defaults to 'kos_agent_writer'. */
  rdsIamUser?: string;
}

export interface MvRefresherWiring {
  refresher: KosLambda;
  schedule: CfnSchedule;
  schedulerRole: Role;
}

/**
 * Plan 06-04 wiring: entity-timeline-refresher Lambda + EventBridge
 * Scheduler entry `entity-timeline-refresher-5min` (`rate(5 minutes)`,
 * Europe/Stockholm, mode=OFF).
 *
 * Memory 256 MB / timeout 30 s — REFRESH CONCURRENTLY at 100k rows is
 * sub-2-second per RESEARCH §11; the 30 s budget is generous.
 */
export function wireMvRefresher(
  scope: Construct,
  props: WireMvRefresherProps,
): MvRefresherWiring {
  const stack = Stack.of(scope);
  const rdsIamUser = props.rdsIamUser ?? 'kos_agent_writer';
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${rdsIamUser}`;

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // --- entity-timeline-refresher Lambda (MEM-04) ---------------------------
  const refresher = new KosLambda(scope, 'EntityTimelineRefresher', {
    entry: svcEntry('entity-timeline-refresher'),
    timeout: Duration.seconds(30),
    memory: 256,
    ...vpcConfig,
    environment: {
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      DATABASE_HOST: props.rdsProxyEndpoint,
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'kos',
      DATABASE_USER: rdsIamUser,
      RDS_IAM_USER: rdsIamUser,
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
      ...(props.langfusePublicKeySecret
        ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: props.langfusePublicKeySecret.secretArn }
        : {}),
      ...(props.langfuseSecretKeySecret
        ? { LANGFUSE_SECRET_KEY_SECRET_ARN: props.langfuseSecretKeySecret.secretArn }
        : {}),
    },
  });

  // --- IAM grants ----------------------------------------------------------
  // Minimal: rds-db:connect ONLY (no bedrock, no events:PutEvents, no
  // notion). The refresher's only side-effect is the REFRESH SQL.
  refresher.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  props.sentryDsnSecret?.grantRead(refresher);
  props.langfusePublicKeySecret?.grantRead(refresher);
  props.langfuseSecretKeySecret?.grantRead(refresher);

  // --- Scheduler role ------------------------------------------------------
  const schedulerRole =
    props.schedulerRole ??
    new Role(scope, 'EntityTimelineRefresherSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
  refresher.grantInvoke(schedulerRole);

  // --- Scheduler entry: entity-timeline-refresher-5min ---------------------
  // D-25: rate(5 minutes), Europe/Stockholm, flexibleTimeWindow OFF.
  const schedule = new CfnSchedule(scope, 'EntityTimelineRefresherSchedule', {
    name: 'entity-timeline-refresher-5min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'rate(5 minutes)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: refresher.functionArn,
      roleArn: schedulerRole.roleArn,
      input: '{}',
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return { refresher, schedule, schedulerRole };
}
