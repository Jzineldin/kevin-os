/**
 * Voice-capture Lambda (AGT-02) — EventBridge target on `kos.triage`
 * consuming `triage.routed` events with `route='voice-capture'`.
 *
 * Flow:
 *   1. Parse triage.routed (FINAL wide schema; Plan 02-04 Task 1).
 *   2. Filter out non-voice-capture routes (defence-in-depth alongside the
 *      EventBridge rule's `detail.route: ['voice-capture']` filter).
 *   3. D-21 idempotency (agent_runs status='ok' check).
 *   4. Load Kevin Context block + call Haiku 4.5 to produce structured row.
 *   5. Write Notion Command Center row → page_id.
 *   6. Emit one entity.mention.detected per detected entity to kos.agent
 *      (batched up to 10 per PutEvents call — EventBridge limit).
 *   7. Emit one output.push to kos.output with is_reply=true so push-telegram
 *      (Plan 02-06) sends the final "✅ Saved to Command Center" ack as a
 *      reply to the original Telegram message.
 *   8. UPDATE agent_runs status='ok' (or 'error').
 *   9. Always `await langfuseFlush()` in finally.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  TriageRoutedSchema,
  EntityMentionDetectedSchema,
} from '@kos/contracts';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { runVoiceCaptureAgent } from './agent.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  loadKevinContextBlock,
} from './persist.js';
import { writeCommandCenterRow } from './notion.js';

process.env.CLAUDE_CODE_USE_BEDROCK = '1';
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: 'eu-north-1' });

interface EBEvent {
  detail: unknown;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const d = TriageRoutedSchema.parse(event.detail);
    if (d.route !== 'voice-capture') return { skipped: d.route };

    if (await findPriorOkRun(d.capture_id, 'voice-capture', ownerId)) {
      return { idempotent: d.capture_id };
    }

    // Cross-agent correlation: Langfuse session.id = capture_id (D-25).
    tagTraceWithCaptureId(d.capture_id);

    const runId = await insertAgentRun({
      ownerId,
      captureId: d.capture_id,
      agentName: 'voice-capture',
      status: 'started',
    });

    try {
      const kevinContextBlock = await loadKevinContextBlock(ownerId);
      const { output, usage } = await runVoiceCaptureAgent({
        captureId: d.capture_id,
        text: d.source_text,
        kevinContextBlock,
        triageHint: { type: d.detected_type, urgency: d.urgency },
      });

      const pageId = await writeCommandCenterRow({
        captureId: d.capture_id,
        title: output.title,
        type: output.type,
        urgency: output.urgency,
        body: output.body,
      });

      // One entity.mention.detected per candidate. Batched in groups of 10
      // (EventBridge PutEvents per-call entry cap).
      const occurredAt = new Date().toISOString();
      const entries = output.candidate_entities.map((e) => ({
        EventBusName: 'kos.agent',
        Source: 'kos.agent',
        DetailType: 'entity.mention.detected',
        Detail: JSON.stringify(
          EntityMentionDetectedSchema.parse({
            capture_id: d.capture_id,
            mention_text: e.mention_text,
            context_snippet: e.context_snippet,
            candidate_type: e.candidate_type,
            source: d.source_kind === 'voice' ? 'telegram-voice' : 'telegram-text',
            occurred_at: occurredAt,
            notion_command_center_page_id: pageId,
          }),
        ),
      }));
      for (let i = 0; i < entries.length; i += 10) {
        await eb.send(new PutEventsCommand({ Entries: entries.slice(i, i + 10) }));
      }

      // Final user-facing ack — push-telegram (Plan 02-06) consumes
      // output.push and sends a reply to the original Telegram message.
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.output',
              Source: 'kos.output',
              DetailType: 'output.push',
              Detail: JSON.stringify({
                capture_id: d.capture_id,
                is_reply: true,
                body: `✅ Saved to Command Center · ${output.title.slice(0, 60)}`,
                telegram: {
                  chat_id: d.telegram.chat_id,
                  reply_to_message_id: d.telegram.message_id,
                },
              }),
            },
          ],
        }),
      );

      await updateAgentRun(runId, {
        status: 'ok',
        outputJson: {
          notion_page_id: pageId,
          entities: output.candidate_entities.length,
        },
        tokensInput: usage.inputTokens,
        tokensOutput: usage.outputTokens,
      });

      return { notion_page_id: pageId, entities: output.candidate_entities.length };
    } catch (err) {
      await updateAgentRun(runId, { status: 'error', errorMessage: String(err) });
      throw err;
    }
  } finally {
    await langfuseFlush();
  }
});
