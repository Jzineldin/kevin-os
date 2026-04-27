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
import {
  isChatQuestion,
  stripGreetingPrefix,
  invokeChat,
} from './chat-route.js';
import { runVoiceCaptureAgent } from './agent.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  loadKevinContextBlock,
  getPool,
} from './persist.js';
import { writeCommandCenterRow } from './notion.js';
// Phase 6 AGT-04: explicit loadContext() call replaces the abandoned SDK
// pre-call hook (Locked Decision #3 revised 2026-04-23).
import { loadContext } from '@kos/context-loader';
// Phase 6 AGT-04 gap closure (Plan 06-07): inject hybridQuery as the Azure
// semantic search callable. Without this injection semanticChunks is always
// []. The wrapper projects HybridQueryResult.hits → SearchHit[].
import { hybridQuery } from '@kos/azure-search';

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

    // Phase 11 Plan 11-04 part B: voice-to-chat routing. If the transcript
    // reads like a question to KOS ("hej kos vem är Robin?", "what did
    // Damien email about?"), skip the Notion/Command Center write and
    // route to the /chat backend instead. Reply via kos.output like
    // normal voice-capture, just with the answer as body.
    if (d.telegram && isChatQuestion({ text: d.source_text })) {
      const runId = await insertAgentRun({
        ownerId,
        captureId: d.capture_id,
        agentName: 'voice-capture:chat',
        status: 'started',
      });
      try {
        const query = stripGreetingPrefix(d.source_text);
        const { answer } = await invokeChat(query);
        const body = (answer || '(tomt svar — försök igen)').slice(0, 4000);
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
                  body,
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
            routed_to: 'chat',
            answer_length: body.length,
            original_text_length: d.source_text.length,
          },
        });
        return { routed_to_chat: d.capture_id };
      } catch (err) {
        await updateAgentRun(runId, {
          status: 'error',
          errorMessage: String((err as Error).message).slice(0, 400),
        });
        // Fall through to normal capture flow on chat failure — losing
        // a capture is worse than doubling up.
        console.warn('[voice-capture] chat route failed, falling through to capture:', err);
      }
    }

    const runId = await insertAgentRun({
      ownerId,
      captureId: d.capture_id,
      agentName: 'voice-capture',
      status: 'started',
    });

    try {
      // Phase 6 AGT-04: loadContext() — degrades to Kevin-Context-only on failure.
      let contextMarkdown: string;
      try {
        const pool = await getPool();
        const bundle = await loadContext({
          entityIds: [],
          agentName: 'voice-capture',
          captureId: d.capture_id,
          ownerId,
          rawText: d.source_text,
          maxSemanticChunks: 8,
          pool,
          azureSearch: ({ rawText: rt, entityIds: eids, topK }) =>
            hybridQuery({ rawText: rt, entityIds: eids, topK }).then((r) => r.hits),
        });
        contextMarkdown = bundle.assembled_markdown;
      } catch (err) {
        console.warn('[voice-capture] loadContext failed, fallback to Kevin Context only:', err);
        contextMarkdown = await loadKevinContextBlock(ownerId);
      }
      const { output, usage } = await runVoiceCaptureAgent({
        captureId: d.capture_id,
        text: d.source_text,
        kevinContextBlock: contextMarkdown,
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
      // 2026-04-24: dashboard-sourced captures have no Telegram message to
      // reply to — classify the mention source accordingly.
      const isDashboard = d.channel === 'dashboard' || !d.telegram;
      const mentionSource = isDashboard
        ? ('dashboard-text' as const)
        : d.source_kind === 'voice'
          ? ('telegram-voice' as const)
          : ('telegram-text' as const);

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
            source: mentionSource,
            occurred_at: occurredAt,
            notion_command_center_page_id: pageId,
          }),
        ),
      }));
      for (let i = 0; i < entries.length; i += 10) {
        await eb.send(new PutEventsCommand({ Entries: entries.slice(i, i + 10) }));
      }

      // Final user-facing ack — only emitted for Telegram-sourced captures.
      // Dashboard captures get their ack via the SSE pipeline (capture_ack
      // kind in migration 0009 agent_runs trigger).
      if (d.telegram && !isDashboard) {
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
      }

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
