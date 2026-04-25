/**
 * Phase 7 / Plan 07-00 — lifecycle automation wiring helper.
 *
 * Surface: `wireLifecycleAutomation` — creates the four Phase 7 brief
 * Lambdas + the two scheduler roles that Plans 07-01..07-04 attach
 * schedules to. Mirrors the `integrations-notion.ts` split-by-helper pattern:
 *
 *   wireLifecycleAutomation(scope, props)
 *     ├── morningBrief             KosLambda  (AUTO-01, Plan 07-01)
 *     ├── dayClose                 KosLambda  (AUTO-03, Plan 07-02)
 *     ├── weeklyReview             KosLambda  (AUTO-04, Plan 07-02)
 *     ├── verifyNotificationCap    KosLambda  (D-07,    Plan 07-04)
 *     ├── schedulerRole            Role       (briefs   Plan 07-01..04)
 *     └── emailTriageSchedulerRole Role       (AUTO-02  Plan 07-03)
 *
 * BODY IS DELIBERATELY MINIMAL. Plans 07-01..07-04 accrete on this helper:
 *   - 07-01: morning-brief schedule + IAM grants (Bedrock, RDS, Secrets,
 *            Notion read, output bus PutEvents).
 *   - 07-02: day-close + weekly-review schedules + same IAM shape.
 *   - 07-03: AUTO-02 email-triage schedule (events:PutEvents on
 *            kos.system targeting the Phase-4 email-triage rule).
 *   - 07-04: verify-notification-cap schedule + cap-table read +
 *            alarmTopic publish IAM + brief.compliance_violation rule.
 *
 * Memory + timeout per D-11. VPC-attached to PRIVATE_WITH_EGRESS subnets
 * with rdsSecurityGroup so RDS Proxy + Secrets Manager VPC endpoint are
 * reachable.
 */
import { Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireLifecycleAutomationProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  notionTokenSecret: ISecret;
  azureSearchAdminSecret: ISecret;
  /** SafetyStack DynamoDB cap table — verify-notification-cap reads it. */
  telegramCapTable: ITable;
  /** SafetyStack SNS topic — verify-notification-cap publishes violations. */
  alarmTopic: ITopic;
  /** Carried for symmetry; brief Lambdas don't subscribe to capture events. */
  captureBus: EventBus;
  /** Carried for symmetry; brief Lambdas don't subscribe to agent events. */
  agentBus: EventBus;
  /** Brief Lambdas emit `output.push` here; consumed by push-telegram. */
  outputBus: EventBus;
  /** AUTO-02 PutEvents target (Phase 7 schedule → Phase 4 email-triage rule). */
  systemBus: EventBus;
  /** Shared 'kos-schedules' EventBridge Scheduler group from EventsStack. */
  scheduleGroupName: string;
}

export interface LifecycleAutomationWiring {
  morningBrief: KosLambda;
  dayClose: KosLambda;
  weeklyReview: KosLambda;
  verifyNotificationCap: KosLambda;
  /** Scheduler role for the 4 brief Lambdas. Plans 07-01..07-04 grantInvoke. */
  schedulerRole: Role;
  /** Separate role with events:PutEvents on kos.system (Plan 07-03). */
  emailTriageSchedulerRole: Role;
}

/**
 * Plan 07-00 stub. Creates the four Lambdas + two roles. IAM/scheduler
 * wiring accretes in Plans 07-01..07-04 by re-extending this helper.
 */
export function wireLifecycleAutomation(
  scope: Construct,
  props: WireLifecycleAutomationProps,
): LifecycleAutomationWiring {
  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // Common environment for the 3 brief Lambdas (verify-notification-cap
  // adds CAP_TABLE_NAME + ALARM_TOPIC_ARN). The Notion *_PAGE_ID +
  // *_DB_ID env vars are added by Plans 07-01..07-02 once the helper
  // accepts them as props.
  const commonEnv = {
    RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
    RDS_IAM_USER: 'kos_admin',
    RDS_DATABASE: 'kos',
    KEVIN_OWNER_ID: '9e4be978-cc7d-571b-98ec-a1e92373682c',
    NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
    AZURE_SEARCH_ADMIN_SECRET_ARN: props.azureSearchAdminSecret.secretArn,
    OUTPUT_BUS_NAME: props.outputBus.eventBusName,
    SYSTEM_BUS_NAME: props.systemBus.eventBusName,
  };

  // --- morning-brief Lambda (AUTO-01) -------------------------------------
  // 1024 MB / 10 min per D-11.
  const morningBrief = new KosLambda(scope, 'MorningBrief', {
    entry: svcEntry('morning-brief'),
    memory: 1024,
    timeout: Duration.minutes(10),
    ...vpcConfig,
    environment: { ...commonEnv },
  });

  // --- day-close Lambda (AUTO-03) ----------------------------------------
  // 1024 MB / 10 min per D-11.
  const dayClose = new KosLambda(scope, 'DayClose', {
    entry: svcEntry('day-close'),
    memory: 1024,
    timeout: Duration.minutes(10),
    ...vpcConfig,
    environment: { ...commonEnv },
  });

  // --- weekly-review Lambda (AUTO-04) ------------------------------------
  // 1536 MB / 10 min per D-11 — needs more headroom for a 7-day rollup.
  const weeklyReview = new KosLambda(scope, 'WeeklyReview', {
    entry: svcEntry('weekly-review'),
    memory: 1536,
    timeout: Duration.minutes(10),
    ...vpcConfig,
    environment: { ...commonEnv },
  });

  // --- verify-notification-cap Lambda (D-07) -----------------------------
  // 512 MB / 3 min per D-11. Reads SafetyStack capTable + emits SNS via
  // alarmTopic on cap-violation.
  const verifyNotificationCap = new KosLambda(scope, 'VerifyNotificationCap', {
    entry: svcEntry('verify-notification-cap'),
    memory: 512,
    timeout: Duration.minutes(3),
    ...vpcConfig,
    environment: {
      ...commonEnv,
      CAP_TABLE_NAME: props.telegramCapTable.tableName,
      ALARM_TOPIC_ARN: props.alarmTopic.topicArn,
    },
  });

  // --- Scheduler roles ---------------------------------------------------
  //
  // Two roles intentionally — the brief schedulerRole has lambda:InvokeFunction
  // on the 4 brief Lambdas (added by Plans 07-01..07-04 via grantInvoke);
  // the emailTriageSchedulerRole has events:PutEvents on kos.system bus
  // (added by Plan 07-03). Splitting roles keeps the AUTO-02 path's IAM
  // surface narrow (no Lambda invoke privileges).
  //
  // Trust policy = scheduler.amazonaws.com without an aws:SourceArn condition,
  // mirroring `integrations-notion.ts` SchedulerRole pattern (live-discovered
  // 2026-04-22; AWS Scheduler validates the role at schedule-creation time
  // BEFORE the schedule ARN exists).
  const schedulerRole = new Role(scope, 'LifecycleSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  // grantInvoke calls land in Plans 07-01 (morning), 07-02 (day + weekly),
  // 07-04 (verify-cap).

  const emailTriageSchedulerRole = new Role(scope, 'EmailTriageSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  // grantPutEventsTo on systemBus added in Plan 07-03.

  return {
    morningBrief,
    dayClose,
    weeklyReview,
    verifyNotificationCap,
    schedulerRole,
    emailTriageSchedulerRole,
  };
}
