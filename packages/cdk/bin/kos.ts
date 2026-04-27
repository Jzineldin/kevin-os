#!/usr/bin/env node
// Note: source-map-support is not imported here to keep the ESM resolver happy
// under Node 22+. Lambda runtime source maps are enabled via
// `NODE_OPTIONS=--enable-source-maps` (set by KosLambda); this file is only
// used at synth time on the developer workstation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { App, Stack, Tags, type Environment } from 'aws-cdk-lib';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import { RESOLVED_ENV } from '../lib/config/env.js';
import { NetworkStack } from '../lib/stacks/network-stack.js';
import { EventsStack } from '../lib/stacks/events-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { IntegrationsStack } from '../lib/stacks/integrations-stack.js';
import { SafetyStack } from '../lib/stacks/safety-stack.js';
import { CaptureStack } from '../lib/stacks/capture-stack.js';
import { AgentsStack } from '../lib/stacks/agents-stack.js';
import { ObservabilityStack } from '../lib/stacks/observability-stack.js';
import { DashboardStack } from '../lib/stacks/dashboard-stack.js';
import { MigrationStack } from '../lib/stacks/integrations-migration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcribeRegion = (() => {
  try {
    return readFileSync(join(__dirname, '..', '..', '..', 'scripts', '.transcribe-region'), 'utf8').trim();
  } catch {
    return 'eu-north-1';
  }
})();

const app = new App();
const env: Environment = RESOLVED_ENV;

// Fail-fast pre-synth validation. A CDK deploy that silently omits these
// env vars has twice now deleted live Lambdas (gmail-poller,
// calendar-reader, granola-poller) because their wiring is gated on
// `if (props.kevinOwnerId) { ... }` and similar conditions. Detect the
// empty-string fallback here and stop synth with a clear error instead
// of producing a broken CloudFormation template.
//
// Override for local tests: set KOS_ALLOW_MISSING_CONTEXT=1.
const allowMissing = process.env.KOS_ALLOW_MISSING_CONTEXT === '1';
const requiredFromEnvOrContext: Array<{ env: string; ctx: string }> = [
  { env: 'KEVIN_OWNER_ID', ctx: 'kevinOwnerId' },
  { env: 'NOTION_TODAY_PAGE_ID', ctx: 'notionTodayPageId' },
  { env: 'NOTION_COMMAND_CENTER_DB_ID', ctx: 'notionCommandCenterDbId' },
];
const missing = requiredFromEnvOrContext.filter(
  (v) =>
    !process.env[v.env] &&
    !(app.node.tryGetContext(v.ctx) as string | undefined),
);
if (missing.length > 0 && !allowMissing) {
  const lines = missing.map((v) => `  - ${v.env} (or cdk context: ${v.ctx})`);
  const msg = [
    'CDK synth aborted — required configuration is missing:',
    ...lines,
    '',
    'These drive runtime behaviour for the dashboard + pollers. Set the env',
    'vars before running `cdk deploy`, e.g.',
    '',
    '  export KEVIN_OWNER_ID=7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
    '  export NOTION_TODAY_PAGE_ID=<from scripts/.notion-db-ids.json>',
    '  export NOTION_COMMAND_CENTER_DB_ID=<from scripts/.notion-db-ids.json>',
    '',
    'Or bypass for local tests with KOS_ALLOW_MISSING_CONTEXT=1.',
  ].join('\n');
  console.error(`\n\u001b[31m${msg}\u001b[0m\n`);
  process.exit(1);
}

// Stacks added by Plans 01-07:
//   NetworkStack      — Plan 01
//   DataStack         — Plan 02
//   EventsStack       — Plan 03
//   SafetyStack       — Plan 02-06 (push-telegram + cap table + alarmTopic)
//   IntegrationsStack — Plans 04, 05, 06, 07 (07 reads SafetyStack refs)
//   CaptureStack      — Plan 02-01 (CAP-01 Telegram ingress)
const network = new NetworkStack(app, 'KosNetwork', { env });
const events = new EventsStack(app, 'KosEvents', { env });
const data = new DataStack(app, 'KosData', {
  env,
  vpc: network.vpc,
  s3Endpoint: network.s3GatewayEndpoint,
});

// SafetyStack moved BEFORE IntegrationsStack so Phase 7 lifecycle wiring
// can pass `telegramCapTable` + `alarmTopic` into IntegrationsStack
// (verify-notification-cap reads the cap table and emits via alarmTopic).
const safety = new SafetyStack(app, 'KosSafety', {
  env,
  rdsSecret: data.rdsCredentialsSecret,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  // 2026-04-22: push-telegram now in VPC for RDS Proxy access.
  vpc: network.vpc,
  rdsSecurityGroup: data.rdsSecurityGroup,
  rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
  telegramBotTokenSecret: data.telegramBotTokenSecret,
  // Plan 02-06: push-telegram consumes output.push events from kos.output.
  outputBus: events.buses.output,
});
// Plan 02-06: SafetyStack now takes a reference to the kos.output bus,
// so it depends on EventsStack. addDependency keeps `cdk deploy` order
// correct (EventsStack provisions the bus before SafetyStack's rule).
safety.addDependency(events);

const integrations = new IntegrationsStack(app, 'KosIntegrations', {
  env,
  vpc: network.vpc,
  rdsSecurityGroup: data.rdsSecurityGroup,
  rdsSecret: data.rdsCredentialsSecret,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
  notionTokenSecret: data.notionTokenSecret,
  azureSearchAdminSecret: data.azureSearchAdminSecret,
  blobsBucket: data.blobsBucket,
  transcribeRegion,
  captureBus: events.buses.capture,
  systemBus: events.buses.system,
  scheduleGroupName: events.scheduleGroupName,
  // Phase 6 Plan 06-01: granola-poller wiring. KEVIN_OWNER_ID + Sentry +
  // Langfuse secrets propagate into the Lambda env so the D-28 instrumentation
  // can resolve at cold start.
  kevinOwnerId:
    process.env.KEVIN_OWNER_ID ??
    (app.node.tryGetContext('kevinOwnerId') as string | undefined) ??
    '',
  sentryDsnSecret: data.sentryDsnSecret,
  langfusePublicKeySecret: data.langfusePublicSecret,
  langfuseSecretKeySecret: data.langfuseSecretSecret,
  // Phase 6 Plan 06-05 (INF-10): Vertex dossier-loader. Activated only when
  // both `kevinOwnerId` and `GCP_PROJECT_ID` are supplied (env or context).
  // The SA secret shell is created unconditionally in DataStack; the
  // pipeline only synthesises here when GCP_PROJECT_ID is known so we don't
  // emit a Lambda with an empty project id env var.
  gcpVertexSaSecret: data.gcpVertexSaSecret,
  gcpProjectId:
    process.env.GCP_PROJECT_ID ??
    (app.node.tryGetContext('gcpProjectId') as string | undefined),
  agentBus: events.buses.agent,
  // Phase 7 Plan 07-00: lifecycle automation wiring (morning-brief + day-
  // close + weekly-review + verify-notification-cap). Capture-table +
  // alarmTopic come from SafetyStack; outputBus from EventsStack. Plans
  // 07-01..07-04 attach schedules + IAM grants by re-extending the helper.
  telegramCapTable: safety.capTable,
  alarmTopic: safety.alarmTopic,
  outputBus: events.buses.output,
  // Phase 4 Plan 04-01 (CAP-02): iOS Action Button webhook. Helper synth-
  // gates on both `blobsBucket` and `iosShortcutWebhookSecret` so absence
  // of either drops the wiring (preserves existing test fixtures).
  iosShortcutWebhookSecret: data.iosShortcutWebhookSecret,
  // Phase 5 Plan 05-01 (CAP-04): Chrome highlight webhook. Helper synth-
  // gates on BOTH chrome secrets so absence of either drops the wiring.
  chromeExtensionBearerSecret: data.chromeExtensionBearerSecret,
  chromeExtensionHmacSecret: data.chromeExtensionHmacSecret,
  // Phase 4 Plan 04-02 (CAP-03): ses-inbound Lambda. Activated by env var
  // / context flag so existing rollouts that haven't run the operator
  // runbook (domain verify + bucket + receiving rule in eu-west-1) don't
  // synth a Lambda whose IAM permission references a not-yet-existing
  // SES rule. See 04-SES-OPERATOR-RUNBOOK.md.
  enableSesInbound:
    (process.env.KOS_ENABLE_SES_INBOUND ??
      (app.node.tryGetContext('enableSesInbound') as string | undefined)) === 'true',
});
integrations.addDependency(safety);
void integrations;
void safety;

// CaptureStack — Plan 02-01 (CAP-01 Telegram ingress).
// KEVIN_TELEGRAM_USER_ID is supplied at synth time via env var or CDK context.
const capture = new CaptureStack(app, 'KosCapture', {
  env,
  blobsBucket: data.blobsBucket,
  telegramBotTokenSecret: data.telegramBotTokenSecret,
  telegramWebhookSecret: data.telegramWebhookSecret,
  sentryDsnSecret: data.sentryDsnSecret,
  captureBus: events.buses.capture,
  systemBus: events.buses.system,
  kevinTelegramUserId:
    process.env.KEVIN_TELEGRAM_USER_ID ??
    (app.node.tryGetContext('kevinTelegramUserId') as string | undefined) ??
    '',
});
capture.addDependency(data);
capture.addDependency(events);
void capture;

// AgentsStack — Plan 02-04 (AGT-01 triage + AGT-02 voice-capture).
// KEVIN_OWNER_ID is the single-user UUID Kevin operates as; supplied via
// env var or CDK context at synth time.
const agents = new AgentsStack(app, 'KosAgents', {
  env,
  captureBus: events.buses.capture,
  triageBus: events.buses.triage,
  agentBus: events.buses.agent,
  outputBus: events.buses.output,
  notionTokenSecret: data.notionTokenSecret,
  sentryDsnSecret: data.sentryDsnSecret,
  langfusePublicSecret: data.langfusePublicSecret,
  langfuseSecretSecret: data.langfuseSecretSecret,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  rdsIamUser: 'kos_admin',
  rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
  kevinOwnerId:
    process.env.KEVIN_OWNER_ID ??
    (app.node.tryGetContext('kevinOwnerId') as string | undefined) ??
    '',
  // VPC + RDS SG so every agent Lambda lands in the private isolated
  // subnets and can reach RDS Proxy. Live-discovered fix (2026-04-22) —
  // without this every `pg.Pool` connection times out.
  vpc: network.vpc,
  rdsSecurityGroup: data.rdsSecurityGroup,
  // Plan 02-09 (ENT-06): wire Gmail OAuth secret created in DataStack so the
  // BulkImportGranolaGmail Lambda has a typed grant + ARN-by-Ref binding.
  gmailOauthSecret: data.gmailOauthSecret,
  // Phase 6 AGT-04 gap closure (Plan 06-07): all 4 agent Lambdas now inject
  // hybridQuery via loadContext, which reads this secret + Azure index name.
  azureSearchAdminSecret: data.azureSearchAdminSecret,
});
agents.addDependency(data);
agents.addDependency(events);
agents.addDependency(integrations); // commandCenter ID source-of-truth
void agents;

// ObservabilityStack — Plan 02-10 (D-25 / D-26 + Resolved Open Q4).
// CloudWatch alarms + SNS topic for the runtime-observability surface.
// Depends on CaptureStack (telegram-bot Fn) + AgentsStack (agent Lambdas).
const observability = new ObservabilityStack(app, 'KosObservability', {
  env,
  telegramBotFn: capture.telegram.bot,
  agentLambdas: [
    agents.agents.triageFn,
    agents.agents.voiceCaptureFn,
    agents.agents.resolverFn,
  ],
});
observability.addDependency(capture);
observability.addDependency(agents);
void observability;

// DashboardStack — Plan 03-04 (Phase 3 dashboard backend compose).
// Composes dashboard-api + dashboard-notify Lambdas + Fargate relay +
// relay-proxy Function URL (Option B ingress, RESEARCH §13) + IAM users +
// Secrets Manager placeholders + EventBridge rule on kos.output.
//
// Notion page IDs are sourced from env vars or CDK context; empty defaults
// are accepted at synth time so the stack composes before the bootstrap
// ran. The dashboard-api runtime surfaces actionable errors on first use if
// either env var is still empty (same pattern as NOTION_KOS_INBOX_DB_ID in
// Plan 02-07).
// KosData is in UPDATE_ROLLBACK_COMPLETE and cannot be updated (RDS Proxy
// rename conflict). The ECS cluster `kos-cluster` exists as a live resource
// but isn't exported by the rolled-back KosData. Create a tiny scope stack
// to host the fromClusterAttributes import (it needs a Stack scope, not App).
const clusterImportStack = new Stack(app, 'KosClusterImport', { env });
const existingCluster = Cluster.fromClusterAttributes(clusterImportStack, 'ExistingKosCluster', {
  clusterName: 'kos-cluster',
  vpc: network.vpc,
  securityGroups: [],
});
const dashboard = new DashboardStack(app, 'KosDashboard', {
  env,
  vpc: network.vpc,
  outputBus: events.buses.output,
  cluster: existingCluster,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
  rdsProxySecurityGroup: data.rdsSecurityGroup,
  notionTokenSecret: data.notionTokenSecret,
  notionTodayPageId:
    process.env.NOTION_TODAY_PAGE_ID ??
    (app.node.tryGetContext('notionTodayPageId') as string | undefined) ??
    '',
  notionCommandCenterDbId:
    process.env.NOTION_COMMAND_CENTER_DB_ID ??
    (app.node.tryGetContext('notionCommandCenterDbId') as string | undefined) ??
    '',
  vercelOriginUrl:
    process.env.VERCEL_ORIGIN_URL ??
    (app.node.tryGetContext('vercelOriginUrl') as string | undefined) ??
    'https://kos-dashboard-kevin-elzarka.vercel.app',
});
dashboard.addDependency(network);
dashboard.addDependency(data);
dashboard.addDependency(events);
void dashboard;

// MigrationStack — Phase 10 Plan 10-00 (Migration & Decommission).
// Provisions the Wave-0 Lambda + Function URL + Scheduler + DynamoDB cursor
// + KMS-encrypted archive bucket scaffolds. Wave 1+ plans (10-01..10-06)
// fill in handler bodies; the CDK wiring stays stable across waves.
const migration = new MigrationStack(app, 'KosMigration', {
  env,
  captureBus: events.buses.capture,
  kevinOwnerId:
    process.env.KEVIN_OWNER_ID ??
    (app.node.tryGetContext('kevinOwnerId') as string | undefined) ??
    '',
  discordChannelIds: ((): string[] => {
    const raw =
      process.env.DISCORD_BRAIN_DUMP_CHANNEL_IDS ??
      (app.node.tryGetContext('discordBrainDumpChannelIds') as string | undefined) ??
      '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  })(),
  // Plan 10-04: single canonical channel id per `05-06-DISCORD-CONTRACT.md`.
  // Env-var-driven for ad-hoc operator override; falls through to the first
  // entry of `discordChannelIds` if unset, then to '' (handler refuses to run
  // without DISCORD_BRAIN_DUMP_CHANNEL_ID — by design).
  discordBrainDumpChannelId:
    process.env.DISCORD_BRAIN_DUMP_CHANNEL_ID ??
    (app.node.tryGetContext('discordBrainDumpChannelId') as string | undefined),
});
migration.addDependency(events);
void migration;

Tags.of(app).add('project', 'kos');
Tags.of(app).add('owner', 'kevin');
app.synth();
