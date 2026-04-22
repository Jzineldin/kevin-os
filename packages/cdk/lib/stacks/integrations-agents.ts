/**
 * AgentsStack wiring helper for Plan 02-04 (AGT-01 + AGT-02).
 *
 * Installs:
 *   - triage Lambda (Haiku 4.5; consumes capture.received + capture.voice.transcribed)
 *   - voice-capture Lambda (Haiku 4.5; consumes triage.routed where route=voice-capture)
 *   - 2 EventBridge rules with per-pipeline DLQs (TriageDlq, VoiceCaptureDlq).
 *     Per-pipeline DLQs live IN this stack (NOT EventsStack) to avoid the
 *     same E↔C cyclic-reference problem Plan 02-02 hit.
 *
 * Plan 02-05 (entity-resolver, AGT-03 / ENT-09) will extend this helper with
 * a third Lambda + a third rule on `kos.agent` consuming entity.mention.detected.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { Duration, Stack } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

function loadCommandCenterId(): string {
  const idFile = path.resolve(REPO_ROOT, 'scripts/.notion-db-ids.json');
  const parsed = JSON.parse(fs.readFileSync(idFile, 'utf8')) as {
    commandCenter?: string;
  };
  if (!parsed.commandCenter) {
    throw new Error(
      'scripts/.notion-db-ids.json missing "commandCenter" — run scripts/bootstrap-notion-dbs.mjs first',
    );
  }
  return parsed.commandCenter;
}

/**
 * KOS Inbox DB ID is created by Plan 02-07 (ENT-11 bootstrap). Until that
 * plan runs the key is absent; inject an empty string at synth time and
 * let the Lambda runtime surface the actionable error on first invocation.
 * This keeps Plan 02-05 synth + deploy unblocked on the Plan 02-07 prereq.
 */
function loadKosInboxIdOrEmpty(): string {
  const idFile = path.resolve(REPO_ROOT, 'scripts/.notion-db-ids.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(idFile, 'utf8')) as { kosInbox?: string };
    return parsed.kosInbox ?? '';
  } catch {
    return '';
  }
}

/**
 * Plan 02-09: Transkripten DB ID is optional at synth time. If present in
 * scripts/.notion-db-ids.json under key "transkripten", inject it; otherwise
 * leave empty and let the Lambda fall back to runtime `notion.search`. The
 * search path costs one extra Notion call per cold-invocation; trivial.
 */
function loadTranskriptenIdOrEmpty(): string {
  const idFile = path.resolve(REPO_ROOT, 'scripts/.notion-db-ids.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(idFile, 'utf8')) as { transkripten?: string };
    return parsed.transkripten ?? '';
  } catch {
    return '';
  }
}

export interface AgentsWiringProps {
  captureBus: EventBus;
  triageBus: EventBus;
  agentBus: EventBus;
  outputBus: EventBus;
  notionTokenSecret: ISecret;
  sentryDsnSecret: ISecret;
  langfusePublicSecret: ISecret;
  langfuseSecretSecret: ISecret;
  rdsProxyEndpoint: string;
  /** kos_admin (matches IntegrationsStack notion-indexer convention). */
  rdsIamUser: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  kevinOwnerId: string;
  /**
   * Plan 02-09 (ENT-06): Gmail OAuth tokens secret (`kos/gmail-oauth-tokens`).
   * Optional — if absent, the BulkImportGranolaGmail Lambda is wired without
   * the grant and Gmail leg gracefully skips. Operator can update later via
   * AWS Secrets Manager + Lambda env update.
   */
  gmailOauthSecret?: ISecret;
}

export interface AgentsWiring {
  triageFn: KosLambda;
  voiceCaptureFn: KosLambda;
  resolverFn: KosLambda;
  bulkImportKontakterFn: KosLambda;
  bulkImportGranolaGmailFn: KosLambda;
  triageRule: Rule;
  voiceCaptureRule: Rule;
  resolverRule: Rule;
}

export function wireTriageAndVoiceCapture(
  scope: Construct,
  p: AgentsWiringProps,
): AgentsWiring {
  const stack = Stack.of(scope);
  const commandCenterId = loadCommandCenterId();
  const kosInboxId = loadKosInboxIdOrEmpty();
  const transkriptenId = loadTranskriptenIdOrEmpty();
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${p.rdsIamUser}`;

  // --- Per-pipeline DLQs (live in this stack to avoid E↔C cycle) ----------
  const triageDlq = new Queue(scope, 'TriageDlq', {
    queueName: 'kos-triage-agent-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });
  const voiceCaptureDlq = new Queue(scope, 'VoiceCaptureDlq', {
    queueName: 'kos-voice-capture-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });
  // Plan 02-05: per-pipeline resolver DLQ. Plan asked for events.dlqs.agent
  // but referencing it from the AgentsStack rule creates an E↔A cyclic
  // reference (EventsStack → AgentsStack via DLQ ARN; AgentsStack →
  // EventsStack via agentBus). Same pattern Plan 02-04 hit. Use a per-
  // pipeline DLQ in this stack instead — Plan 02-09 alarms on it the same
  // way they already alarm on triage + voice-capture DLQs.
  const entityResolverDlq = new Queue(scope, 'EntityResolverDlq', {
    queueName: 'kos-entity-resolver-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });

  // --- Triage Lambda (AGT-01) ---------------------------------------------
  const triageFn = new KosLambda(scope, 'TriageAgent', {
    entry: svcEntry('triage'),
    timeout: Duration.seconds(30),
    memory: 512,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: p.rdsIamUser,
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
      LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicSecret.secretArn,
      LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretSecret.secretArn,
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  });
  grantBedrock(triageFn);
  triageFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  p.sentryDsnSecret.grantRead(triageFn);
  p.langfusePublicSecret.grantRead(triageFn);
  p.langfuseSecretSecret.grantRead(triageFn);
  p.triageBus.grantPutEventsTo(triageFn);

  const triageRule = new Rule(scope, 'TriageFromCaptureRule', {
    eventBus: p.captureBus,
    eventPattern: {
      source: ['kos.capture'],
      detailType: ['capture.received', 'capture.voice.transcribed'],
    },
    targets: [
      new LambdaTarget(triageFn, {
        deadLetterQueue: triageDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  // --- Voice-capture Lambda (AGT-02) --------------------------------------
  const voiceCaptureFn = new KosLambda(scope, 'VoiceCaptureAgent', {
    entry: svcEntry('voice-capture'),
    timeout: Duration.seconds(60),
    memory: 1024,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: p.rdsIamUser,
      NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn,
      // Command Center DB ID injected at synth time so the Lambda doesn't
      // need to bundle scripts/.notion-db-ids.json (mirrors the
      // notion-reconcile env-var pattern from Phase 1).
      NOTION_COMMAND_CENTER_DB_ID: commandCenterId,
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
      LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicSecret.secretArn,
      LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretSecret.secretArn,
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  });
  grantBedrock(voiceCaptureFn);
  voiceCaptureFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  p.notionTokenSecret.grantRead(voiceCaptureFn);
  p.sentryDsnSecret.grantRead(voiceCaptureFn);
  p.langfusePublicSecret.grantRead(voiceCaptureFn);
  p.langfuseSecretSecret.grantRead(voiceCaptureFn);
  p.agentBus.grantPutEventsTo(voiceCaptureFn);
  p.outputBus.grantPutEventsTo(voiceCaptureFn);

  const voiceCaptureRule = new Rule(scope, 'VoiceCaptureFromTriageRule', {
    eventBus: p.triageBus,
    eventPattern: {
      source: ['kos.triage'],
      detailType: ['triage.routed'],
      detail: { route: ['voice-capture'] },
    },
    targets: [
      new LambdaTarget(voiceCaptureFn, {
        deadLetterQueue: voiceCaptureDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  // --- Entity-resolver Lambda (AGT-03 / ENT-09) — Plan 02-05 --------------
  //
  // Timeout 60s (Sonnet 4.6 disambig ≤5s + embed ≤500ms + up to 3 DB + 2
  // Notion calls + PutEvents); memory 1024 MB for SDK + pg + @notionhq
  // + OTel. Consumes entity.mention.detected from kos.agent (emitted by
  // voice-capture). Uses the shared kos.agent DLQ (events.dlqs.agent)
  // rather than per-pipeline to keep Plan 02-09 alarm surface simple.
  const resolverFn = new KosLambda(scope, 'EntityResolver', {
    entry: svcEntry('entity-resolver'),
    timeout: Duration.seconds(60),
    memory: 1024,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: p.rdsIamUser,
      NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn,
      // KOS Inbox DB ID is injected at synth time iff Plan 02-07 bootstrap
      // has already populated scripts/.notion-db-ids.json; otherwise empty
      // and the Lambda throws a clear error when it tries to dual-read.
      NOTION_KOS_INBOX_DB_ID: kosInboxId,
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
      LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicSecret.secretArn,
      LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretSecret.secretArn,
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  });
  grantBedrock(resolverFn);
  // Cohere Embed Multilingual v3 (embedBatch in @kos/resolver) is invoked
  // against Bedrock — grant the foundation-model ARN separately so future
  // embed-model swaps don't drift from the agent grants.
  resolverFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/cohere.embed-multilingual-v3*'],
    }),
  );
  resolverFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  p.notionTokenSecret.grantRead(resolverFn);
  p.sentryDsnSecret.grantRead(resolverFn);
  p.langfusePublicSecret.grantRead(resolverFn);
  p.langfuseSecretSecret.grantRead(resolverFn);
  // The resolver emits mention.resolved back to kos.agent (same bus it
  // reads from — EventBridge supports self-bus PutEvents, the resolver's
  // own rule filters by detail-type so there's no feedback loop).
  p.agentBus.grantPutEventsTo(resolverFn);

  const resolverRule = new Rule(scope, 'EntityResolverFromAgentRule', {
    eventBus: p.agentBus,
    eventPattern: {
      source: ['kos.agent'],
      detailType: ['entity.mention.detected'],
    },
    targets: [
      new LambdaTarget(resolverFn, {
        deadLetterQueue: entityResolverDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  // --- BulkImportKontakter Lambda (Plan 02-08, ENT-05) -------------------
  //
  // One-shot operator-invoked Lambda. No EventBridge rule — invoked on demand
  // via scripts/bulk-import-kontakter.sh. Reads Kontakter Notion DB, dedups
  // against KOS Inbox + entity_index, writes Pending rows. Embeddings NOT
  // written here (Plan 02-08 Task 2 extends notion-indexer to embed on
  // entities upsert when Kevin approves).
  //
  // IAM grants: Notion token secret read, RDS Proxy IAM auth (for entity_index
  // dedup SELECT), bedrock:ListInferenceProfiles (operator discovery
  // breadcrumb). No Bedrock InvokeModel grant — this Lambda does not embed.
  //
  // Timeout 900s (15 min): full Kontakter pull + 350ms-paced creates for 500
  // rows ~= 200s; 900s leaves headroom for cold start + retries. Memory
  // 1024MB for decent cold-start latency on one-shot invocations.
  const bulkImportKontakterFn = new KosLambda(scope, 'BulkImportKontakter', {
    entry: svcEntry('bulk-import-kontakter'),
    timeout: Duration.minutes(15),
    memory: 1024,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: p.rdsIamUser,
      NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn,
      NOTION_KOS_INBOX_DB_ID: kosInboxId,
      // Operator can set KONTAKTER_DB_ID post-discovery via
      // 'aws lambda update-function-configuration' to skip the notion.search
      // round trip on every invocation.
      KONTAKTER_DB_ID_OPTIONAL: '',
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
    },
  });
  bulkImportKontakterFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  // Bedrock list-inference-profiles for the embed-profile discovery breadcrumb
  // (Plan 02-08 Open Question 2 runbook). Lambda only reads metadata, never
  // InvokeModel — that grant stays with indexer (Task 2) and resolver.
  bulkImportKontakterFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:ListInferenceProfiles'],
      resources: ['*'],
    }),
  );
  p.notionTokenSecret.grantRead(bulkImportKontakterFn);
  p.sentryDsnSecret.grantRead(bulkImportKontakterFn);

  // --- BulkImportGranolaGmail Lambda (Plan 02-09, ENT-06) ----------------
  //
  // One-shot operator-invoked Lambda. No EventBridge rule — invoked on demand
  // via scripts/bulk-import-granola-gmail.sh. Reads Notion Transkripten DB
  // (Resolved Open Q1 — NOT Granola REST) + Gmail signatures via OAuth,
  // extracts Person candidates with confidence gating, deduplicates against
  // KOS Inbox + entity_index, writes Pending rows.
  //
  // IAM grants: Notion token secret read, Gmail OAuth secret read (optional —
  // if not wired, Gmail leg gracefully skips), RDS Proxy IAM auth (entity_index
  // dedup SELECT). NO Bedrock InvokeModel — this Lambda doesn't embed.
  //
  // Timeout 900s (15 min): full Transkripten 90-day pull + 350ms-paced creates
  // for ~500 candidates ~= 200s; 900s leaves headroom for Gmail metadata calls.
  // Memory 1024MB.
  const bulkImportGranolaGmailFn = new KosLambda(scope, 'BulkImportGranolaGmail', {
    entry: svcEntry('bulk-import-granola-gmail'),
    timeout: Duration.minutes(15),
    memory: 1024,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: p.rdsIamUser,
      NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn,
      NOTION_KOS_INBOX_DB_ID: kosInboxId,
      // Discriminator for tests + bulk-import grouping (mirrors Plan 02-08).
      // Operator may update post-discovery to skip notion.search round-trip.
      TRANSKRIPTEN_DB_ID_OPTIONAL: transkriptenId,
      // Gmail OAuth secret ID (matches DataStack.gmailOauthSecret name).
      GMAIL_OAUTH_SECRET_ID: 'kos/gmail-oauth-tokens',
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
    },
  });
  bulkImportGranolaGmailFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  p.notionTokenSecret.grantRead(bulkImportGranolaGmailFn);
  p.sentryDsnSecret.grantRead(bulkImportGranolaGmailFn);
  // Gmail OAuth secret grant — optional. If absent, Gmail leg fails fast in
  // loadGmailTokens; the handler catches + sets gmailSkipped=true so the
  // Granola leg still runs. Wiring the grant here when the secret is
  // available avoids the operator having to attach it manually.
  if (p.gmailOauthSecret) {
    p.gmailOauthSecret.grantRead(bulkImportGranolaGmailFn);
  } else {
    // Fallback: grant by ARN pattern so operator can populate the secret
    // post-deploy without re-deploying the stack. The exact-name secret ARN
    // suffix is randomized (-XXXXXX), so use a wildcard.
    bulkImportGranolaGmailFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:kos/gmail-oauth-tokens-*`,
        ],
      }),
    );
  }

  return {
    triageFn,
    voiceCaptureFn,
    resolverFn,
    bulkImportKontakterFn,
    bulkImportGranolaGmailFn,
    triageRule,
    voiceCaptureRule,
    resolverRule,
  };
}

/**
 * Bedrock InvokeModel grant scoped to Haiku 4.5 + Sonnet 4.6 (foundation
 * model + EU CRIS inference profile ARN forms). Future expansion (e.g.
 * Cohere embed) lands here as additional resource patterns.
 */
function grantBedrock(fn: KosLambda) {
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-haiku-4-5*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*',
      ],
    }),
  );
}
