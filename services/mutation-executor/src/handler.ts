/**
 * mutation-executor Lambda (AGT-08, Plan 08-04).
 *
 * Consumes pending_mutation.approved on kos.output, applies the
 * archive-not-delete mutation, and emits pending_mutation.executed.
 *
 * STRUCTURAL invariants (CDK + IAM enforce):
 *   - NO bedrock:* IAM (this Lambda never calls an LLM).
 *   - NO ses:* IAM (no email side-effects).
 *   - NO postiz/* IAM (no social write side-effects).
 *   - NO Google Calendar write scope (D-17).
 *   - DB role kos_mutation_executor has UPDATE only — no DELETE.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  PendingMutationApprovedSchema,
  PendingMutationExecutedSchema,
} from '@kos/contracts';
import {
  getPool,
  loadPendingMutationForExecute,
  markExecuted,
  markFailed,
} from './persist.js';
import { applyMutation } from './applier.js';
import { getNotionClient } from './notion.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION });
const OUTPUT_BUS_NAME = process.env.OUTPUT_BUS_NAME ?? 'kos.output';

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

  try {
    const dt = event['detail-type'];
    if (dt !== 'pending_mutation.approved') {
      return { skipped: dt ?? 'no_detail_type' };
    }

    const detail = PendingMutationApprovedSchema.parse(event.detail);
    tagTraceWithCaptureId(detail.capture_id);

    const pool = await getPool();
    const m = await loadPendingMutationForExecute(pool, detail.mutation_id, ownerId);
    if (!m) return { skipped: 'not_found_or_terminal' };

    // Disambiguation pick: the dashboard route may pass selected_target_ref
    // when Kevin chose an alternative. Use that target_id; fall back to
    // the row's primary target.
    const useTargetKind = detail.selected_target_ref?.kind ?? m.target_kind;
    const useTargetId = detail.selected_target_ref?.id ?? m.target_id;

    // Notion client — only initialise for Notion-backed mutations to avoid
    // a Secrets Manager round-trip for cancel_meeting / cancel_email_draft.
    const needsNotion = m.mutation_type === 'delete_task';
    const notion = needsNotion ? await getNotionClient().catch(() => null) : null;

    const applied = await applyMutation({
      pool,
      ownerId,
      captureId: detail.capture_id,
      mutation_type: m.mutation_type,
      target_kind: useTargetKind,
      target_id: useTargetId,
      notion,
    });

    if (applied.result === 'failed') {
      await markFailed(pool, detail.mutation_id, applied.error);
    } else {
      // For non-failed results we still record any informational error
      // alongside the result (e.g. reschedule_meeting carries a note).
      if (applied.result === 'archived' || applied.result === 'rescheduled' || applied.result === 'no_op') {
        await markExecuted(pool, detail.mutation_id, applied.result);
      }
    }

    // Optional downstream emit (e.g. content.cancel_requested for the
    // content-publisher to clean Postiz scheduled posts).
    if (applied.result !== 'failed' && 'emit' in applied && applied.emit) {
      try {
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: OUTPUT_BUS_NAME,
                Source: 'kos.output',
                DetailType: applied.emit.detailType,
                Detail: JSON.stringify(applied.emit.payload),
              },
            ],
          }),
        );
      } catch (err) {
        console.warn('[mutation-executor] downstream emit failed', err);
      }
    }

    const evt = PendingMutationExecutedSchema.parse({
      capture_id: detail.capture_id,
      mutation_id: detail.mutation_id,
      result: applied.result,
      error: applied.result === 'failed' ? applied.error : applied.error ?? null,
      executed_at: new Date().toISOString(),
    });

    try {
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: OUTPUT_BUS_NAME,
              Source: 'kos.output',
              DetailType: 'pending_mutation.executed',
              Detail: JSON.stringify(evt),
            },
          ],
        }),
      );
    } catch (err) {
      console.warn('[mutation-executor] PutEvents executed failed', err);
    }

    return evt;
  } finally {
    await langfuseFlush();
  }
});
