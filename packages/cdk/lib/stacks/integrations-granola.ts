/**
 * Granola pipeline wiring helper (Phase 6 Plan 06-01).
 *
 * Plan 06-01 surface: `wireGranolaPipeline` — installs the granola-poller
 * Lambda + EventBridge Scheduler entry (rate(15 minutes) Europe/Stockholm)
 * + IAM grants. Mirrors `integrations-notion.ts` exactly: same
 * scheduler-role pattern (NO aws:SourceArn condition per Phase 1 Plan 02-04
 * retro), same KosLambda construct, same VPC config helper.
 *
 * Plan 06-02 will add `wireTranscriptExtractor` to this same file (keeping
 * Phase 6 helpers in one place per the existing convention).
 *
 * Reference:
 *   .planning/phases/06-granola-semantic-memory/06-01-PLAN.md
 *   .planning/phases/06-granola-semantic-memory/06-CONTEXT.md (D-01..D-04)
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

/**
 * Reads the Transkripten DB id from `scripts/.notion-db-ids.json` (key
 * `transkripten`). Returns the empty string if the file or key is missing —
 * matches the deploy-unblock convention used for `kosInbox` in
 * integrations-notion.ts (the runtime Lambda surfaces an actionable error
 * on first poll, see services/granola-poller/src/notion.ts).
 */
function loadTranskriptenId(): string {
  const idFile = path.resolve(REPO_ROOT, 'scripts/.notion-db-ids.json');
  if (!fs.existsSync(idFile)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(idFile, 'utf8')) as Record<string, string>;
    return parsed.transkripten ?? parsed.Transkripten ?? '';
  } catch {
    return '';
  }
}

export interface WireGranolaPipelineProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` — from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  notionTokenSecret: ISecret;
  /**
   * Phase 6 D-28 instrumentation. Optional so synth still works in
   * minimal-prop test fixtures (the runtime degrades gracefully when the
   * env var is unset — see services/_shared/sentry.ts + tracing.ts).
   */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  captureBus: EventBus;
  scheduleGroupName: string;
  /**
   * Optional re-use of the EventBridge Scheduler role created by
   * `wireNotionIntegrations`. If absent, a new role is created scoped to
   * the granola-poller only.
   */
  schedulerRole?: Role;
  /** Single-user UUID Kevin operates as (KEVIN_OWNER_ID). */
  kevinOwnerId: string;
  /** RDS IAM user for `rds-db:connect`. Defaults to 'kos_admin' to match Phase 2. */
  rdsIamUser?: string;
}

export interface GranolaWiring {
  granolaPoller: KosLambda;
  schedulerRole: Role;
  schedule: CfnSchedule;
}

/**
 * Plan 06-01 wiring: granola-poller Lambda + EventBridge Scheduler entry
 * `granola-poller-15min` (rate(15 minutes) Europe/Stockholm, mode=OFF).
 *
 * Granola-poller is intentionally LLM-free (D-22 / Locked Decision #3) —
 * it only polls Notion, validates against TranscriptAvailableSchema, and
 * publishes to kos.capture. No bedrock:InvokeModel grant.
 */
export function wireGranolaPipeline(
  scope: Construct,
  props: WireGranolaPipelineProps,
): GranolaWiring {
  const stack = Stack.of(scope);
  const rdsIamUser = props.rdsIamUser ?? 'kos_admin';
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${rdsIamUser}`;

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // --- granola-poller Lambda (CAP-08 + AUTO-05) -----------------------------
  const granolaPoller = new KosLambda(scope, 'GranolaPoller', {
    entry: svcEntry('granola-poller'),
    timeout: Duration.minutes(2),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: rdsIamUser,
      DATABASE_NAME: 'kos',
      NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
      NOTION_TRANSKRIPTEN_DB_ID: loadTranskriptenId(),
      KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
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

  // --- IAM grants -----------------------------------------------------------
  props.notionTokenSecret.grantRead(granolaPoller);
  props.captureBus.grantPutEventsTo(granolaPoller);
  props.sentryDsnSecret?.grantRead(granolaPoller);
  props.langfusePublicKeySecret?.grantRead(granolaPoller);
  props.langfuseSecretKeySecret?.grantRead(granolaPoller);
  granolaPoller.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  // --- Scheduler role -------------------------------------------------------
  // Trust scheduler.amazonaws.com; NO aws:SourceArn condition per the
  // Phase 1 Plan 02-04 retro pitfall ("scheduler validates the role at
  // schedule-creation time before the schedule ARN exists"). Blast radius
  // narrow because grantInvoke restricts which Lambdas this role can fire.
  const schedulerRole =
    props.schedulerRole ??
    new Role(scope, 'GranolaSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
  granolaPoller.grantInvoke(schedulerRole);

  // --- Scheduler entry: granola-poller-15min --------------------------------
  // D-02: rate(15 minutes), Europe/Stockholm, flexibleTimeWindow OFF.
  // Retry policy mirrors Phase 1 patterns (2 retries, 5-min event age).
  const schedule = new CfnSchedule(scope, 'GranolaPollerSchedule', {
    name: 'granola-poller-15min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'rate(15 minutes)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: granolaPoller.functionArn,
      roleArn: schedulerRole.roleArn,
      input: '{}',
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return { granolaPoller, schedulerRole, schedule };
}
