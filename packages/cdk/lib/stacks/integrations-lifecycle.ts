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
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNotionIds } from './_notion-ids.js';

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

  // Notion IDs (Plan 07-01: Today page + Daily Brief Log DB).
  const notionIds = loadNotionIds();
  const stack = Stack.of(scope);
  const rdsDbConnectArn = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/kos_admin`;

  // --- Scheduler roles (declared early so per-Lambda schedules can grantInvoke) ---
  //
  // Two roles intentionally — the brief schedulerRole has lambda:InvokeFunction
  // on the 4 brief Lambdas (added per-plan via grantInvoke as Plans 07-01..07-04
  // accrete); the emailTriageSchedulerRole has events:PutEvents on kos.system
  // (Plan 07-03). Splitting roles keeps the AUTO-02 path's IAM surface narrow
  // (no Lambda invoke privileges).
  //
  // Trust policy = scheduler.amazonaws.com without an aws:SourceArn condition,
  // mirroring `integrations-notion.ts` SchedulerRole pattern (live-discovered
  // 2026-04-22; AWS Scheduler validates the role at schedule-creation time
  // BEFORE the schedule ARN exists).
  const schedulerRole = new Role(scope, 'LifecycleSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  const emailTriageSchedulerRole = new Role(scope, 'EmailTriageSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });

  // --- morning-brief Lambda (AUTO-01) -------------------------------------
  // 1024 MB / 10 min per D-11. Adds NOTION_TODAY_PAGE_ID +
  // NOTION_DAILY_BRIEF_LOG_DB_ID + DASH_URL to the common env (Plan 07-01).
  const morningBrief = new KosLambda(scope, 'MorningBrief', {
    entry: svcEntry('morning-brief'),
    memory: 1024,
    timeout: Duration.minutes(10),
    ...vpcConfig,
    environment: {
      ...commonEnv,
      NOTION_TODAY_PAGE_ID: notionIds.todayPage,
      NOTION_DAILY_BRIEF_LOG_DB_ID: notionIds.dailyBriefLog,
      DASH_URL: 'https://kevin-os.vercel.app',
    },
  });

  // --- Morning brief IAM grants (Plan 07-01 D-12) ------------------------
  //
  // Bedrock InvokeModel on the EU Sonnet 4.6 inference profile + the
  // foundation-model fan-out ARNs (AnthropicBedrock SDK resolves both at
  // call time).
  morningBrief.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
      ],
    }),
  );
  // RDS Proxy IAM auth on kos_admin (top3_membership writes + agent_runs +
  // dropped_threads_v reads + email_drafts graceful-degrade query).
  morningBrief.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectArn],
    }),
  );
  // Notion (replace-in-place 🏠 Today + Daily Brief Log append).
  props.notionTokenSecret.grantRead(morningBrief);
  // Azure Search admin secret (loadContext.azureSearch hybridQuery).
  props.azureSearchAdminSecret.grantRead(morningBrief);
  // Output bus — the single output.push event per brief run (1-of-3 cap).
  props.outputBus.grantPutEventsTo(morningBrief);
  // System bus — brief.generation_failed on Bedrock/Notion failure path.
  props.systemBus.grantPutEventsTo(morningBrief);

  // --- Morning brief schedule (D-18: 08:00 Stockholm Mon-Fri) ------------
  //
  // 08:00 NOT 07:00 — D-18 honours the 20:00–08:00 quiet-hours invariant
  // cleanly (push-telegram's isQuietHour returns false at 08:00). The
  // 07:00 → 08:00 drift from the original AUTO-01 spec is documented in
  // 07-01-SUMMARY.md.
  morningBrief.grantInvoke(schedulerRole);
  new CfnSchedule(scope, 'MorningBriefSchedule', {
    name: 'morning-brief-weekdays-08',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'cron(0 8 ? * MON-FRI *)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: morningBrief.functionArn,
      roleArn: schedulerRole.roleArn,
      input: JSON.stringify({ kind: 'morning-brief' }),
    },
    state: 'ENABLED',
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

  // --- AUTO-02 email-triage every-2h scheduler (Plan 07-03) ---------------
  //
  // Phase 4 (Plan 04-04 Task 4) owns the email-triage Lambda + an
  // EventBridge Rule on `kos.system / scan_emails_now` → email-triage. Phase
  // 7 contributes ZERO Lambda code for AUTO-02; only this scheduler. When
  // Phase 4 ships its rule, the wire connects automatically.
  //
  // Per Plan 07-03 must_haves truths + 07-CONTEXT D-16:
  //   - Schedule cron(0 8/2 ? * MON-FRI *) Europe/Stockholm fires 6x/weekday
  //     (08, 10, 12, 14, 16, 18 Stockholm) → ~30 fires/week → ~120/month.
  //   - Target = systemBus (EventBridge) via the templated PutEvents target;
  //     `target.eventBridgeParameters` carries `detailType=scan_emails_now`
  //     and `source=kos.system`; `target.input` is the Detail JSON matching
  //     the shape produced by `scripts/fire-scan-emails-now.mjs` (Plan 04-05).
  //   - emailTriageSchedulerRole has ONLY `events:PutEvents` on systemBus
  //     (structural least-privilege; no Lambda invoke; no other surfaces).
  //   - flexibleTimeWindow OFF — fire on the exact wall-clock minute.
  //
  // Phase 4 independence note: targeting the EventBridge bus (NOT the
  // email-triage Lambda directly) keeps Phase 7 deployable BEFORE Phase 4
  // ships. The Phase 4 Lambda + rule become the consumer when they land;
  // until then the events fan out to zero subscribers (ignored, no failure).
  props.systemBus.grantPutEventsTo(emailTriageSchedulerRole);
  new CfnSchedule(scope, 'EmailTriageEvery2hSchedule', {
    name: 'email-triage-every-2h',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'cron(0 8/2 ? * MON-FRI *)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      // Templated EventBridge PutEvents target — `target.arn = bus ARN` and
      // `eventBridgeParameters` carry DetailType+Source. The Detail body
      // (target.input) matches the operator-trigger envelope from Plan 04-05
      // (`scripts/fire-scan-emails-now.mjs`): `requested_by: 'scheduler'`
      // distinguishes scheduled fires from manual operator runs.
      //
      // capture_id is a placeholder — the email-triage Lambda generates its
      // own per-row ULID when processing a scan_emails_now batch. If Plan
      // 04-04 doesn't already do this, the gap is documented in 07-03-SUMMARY
      // for Phase 4's next revision.
      arn: props.systemBus.eventBusArn,
      roleArn: emailTriageSchedulerRole.roleArn,
      eventBridgeParameters: {
        detailType: 'scan_emails_now',
        source: 'kos.system',
      },
      input: JSON.stringify({
        capture_id: '01SCHEDULER000000000000000',
        // `<aws.scheduler.scheduled-time>` is an EventBridge Scheduler
        // context attribute — expanded at fire time to the scheduled ISO
        // timestamp. AWS Scheduler User Guide:
        // https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html
        requested_at: '<aws.scheduler.scheduled-time>',
        requested_by: 'scheduler',
      }),
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return {
    morningBrief,
    dayClose,
    weeklyReview,
    verifyNotificationCap,
    schedulerRole,
    emailTriageSchedulerRole,
  };
}
