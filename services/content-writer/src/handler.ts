/**
 * content-writer orchestrator Lambda (AGT-07; Plan 08-02 Task 1).
 *
 * Receives `content.topic_submitted` events on the kos.agent bus, validates
 * the payload, and starts the `kos-content-writer-5platform` Step Functions
 * Map state machine — one execution per topic, one Map item per platform.
 * The actual Bedrock Sonnet 4.6 calls happen inside content-writer-platform
 * (see ../../content-writer-platform).
 *
 * IAM (CDK helper enforces; CDK tests assert):
 *   - states:StartExecution on the state-machine ARN
 *   - events:PutEvents on kos.agent (orchestration.started observability event)
 *   - rds-db:connect as kos_content_writer_orchestrator
 *   - **NO bedrock:*** — this Lambda never calls a model
 *   - **NO postiz:*, NO ses:*** — the orchestrator only schedules drafts
 *
 * Idempotency (Plan 08-02 Task 1 Test 4):
 *   1. content_drafts pre-check on (topic_id, owner_id) — when at least
 *      one row exists, return { skipped: 'already_drafted' } and skip the
 *      Step Functions invocation entirely.
 *   2. SFN execution `name` is derived deterministically from topic_id
 *      (`cw-${topic_id}`); duplicate StartExecution calls collide on the
 *      name and return the existing execution rather than creating a new
 *      one (Step Functions Standard semantics).
 *
 * Defaults: when `platforms` is missing/empty in the inbound detail (which
 * Zod rejects on the explicit schema) the orchestrator falls back to all
 * five supported platforms. The fallback is defensive — the Zod schema
 * already requires .min(1).max(5), so the only practical path that hits
 * the fallback is the orchestrator being invoked with a hand-crafted
 * detail by the operator script (Plan 08-02 Task 3).
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ContentTopicSubmittedSchema } from '@kos/contracts';
import { alreadyDrafted, getPool } from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const sfn = new SFNClient({ region: process.env.AWS_REGION });
const eb = new EventBridgeClient({ region: process.env.AWS_REGION });

/** Bus where the orchestrator emits content.orchestration.started for observability. */
const AGENT_BUS_NAME = process.env.AGENT_BUS_NAME ?? 'kos.agent';

const ALL_PLATFORMS = [
  'instagram',
  'linkedin',
  'tiktok',
  'reddit',
  'newsletter',
] as const;

interface EBEvent {
  source?: string;
  'detail-type'?: string;
  detail?: unknown;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();

  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');
  const stateMachineArn = process.env.SFN_CONTENT_WRITER_ARN;
  if (!stateMachineArn) throw new Error('SFN_CONTENT_WRITER_ARN not set');

  try {
    const dt = event['detail-type'];
    if (dt !== 'content.topic_submitted') {
      return { skipped: dt ?? 'no-detail-type' };
    }

    // Zod parse — rejects malformed payloads (missing topic_text, bad ULID,
    // unknown platform values, etc.). Test 2.
    const detail = ContentTopicSubmittedSchema.parse(event.detail);

    tagTraceWithCaptureId(detail.capture_id);

    // Idempotency pre-check on (topic_id, owner_id). Test 4.
    const pool = await getPool();
    if (await alreadyDrafted(pool, detail.topic_id, ownerId)) {
      return { skipped: 'already_drafted', topic_id: detail.topic_id };
    }

    // Defensive default: schema already requires .min(1) so this branch is
    // only reachable through a hand-crafted invocation. Test 3.
    const platforms =
      detail.platforms.length > 0 ? detail.platforms : [...ALL_PLATFORMS];

    const sfnInput = JSON.stringify({
      topic_id: detail.topic_id,
      capture_id: detail.capture_id,
      topic_text: detail.topic_text,
      platforms,
    });

    // Step Functions execution name is derived deterministically from
    // topic_id (a ULID — already URL-safe, ≤80 chars). Replays of the
    // same topic_submitted event collide on the name; SFN returns the
    // existing execution instead of creating a duplicate.
    const startResp = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: `cw-${detail.topic_id}`,
        input: sfnInput,
      }),
    );

    // Observability fan-out — single event so downstream Langfuse/dashboard
    // can correlate the SFN execution back to the originating topic. Test 6.
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: AGENT_BUS_NAME,
            Source: 'kos.agent',
            DetailType: 'content.orchestration.started',
            Detail: JSON.stringify({
              capture_id: detail.capture_id,
              topic_id: detail.topic_id,
              platforms,
              execution_arn: startResp.executionArn,
              started_at: new Date().toISOString(),
            }),
          },
        ],
      }),
    );

    // Test 7.
    return {
      execution_arn: startResp.executionArn,
      topic_id: detail.topic_id,
    };
  } finally {
    await langfuseFlush();
  }
});
