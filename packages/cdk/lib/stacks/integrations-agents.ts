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
}

export interface AgentsWiring {
  triageFn: KosLambda;
  voiceCaptureFn: KosLambda;
  resolverFn: KosLambda;
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
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${p.rdsIamUser}`;

  // --- Per-pipeline DLQs (live in this stack to avoid E↔C cycle) ----------
  const triageDlq = new Queue(scope, 'TriageDlq', {
    queueName: 'kos-triage-dlq',
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

  return {
    triageFn,
    voiceCaptureFn,
    resolverFn,
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
