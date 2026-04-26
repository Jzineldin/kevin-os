/**
 * Triage Lambda (AGT-01) — EventBridge target on `kos.capture` consuming both
 * `capture.received` (text) and `capture.voice.transcribed` (voice).
 *
 * Flow:
 *   1. Parse + validate detail by `detail-type`.
 *   2. D-21 idempotency: SELECT-before-run on agent_runs (status='ok').
 *   3. INSERT agent_runs row with status='started'.
 *   4. Load Kevin Context block + call Haiku 4.5 via Agent SDK.
 *   5. Publish `triage.routed` to `kos.triage` with the FINAL wide schema
 *      (carries source_text + sender + telegram so voice-capture has
 *      everything it needs without re-fetching).
 *   6. UPDATE agent_runs row with status='ok' (or 'error').
 *   7. Always `await langfuseFlush()` in finally — Pitfall 9.
 *
 * Triage MUST NOT invoke push-telegram directly (Cap separation per D-04).
 * The user-facing ack is emitted by voice-capture as `output.push` with
 * is_reply=true (Plan 02-06 push-telegram consumer).
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CaptureReceivedTextSchema,
  CaptureReceivedChromeHighlightSchema,
  CaptureReceivedLinkedInDmSchema,
  CaptureVoiceTranscribedSchema,
  TriageRoutedSchema,
} from '@kos/contracts';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { runTriageAgent } from './agent.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  loadKevinContextBlock,
  getPool,
} from './persist.js';
// Phase 6 AGT-04: explicit loadContext() replaces the abandoned Claude Agent
// SDK pre-call hook pattern (Locked Decision #3 revised 2026-04-23). The
// older loadKevinContextBlock() is preserved as a fallback when the
// @kos/context-loader library fails (degraded operation).
import { loadContext } from '@kos/context-loader';
// Phase 6 AGT-04 gap closure (Plan 06-07): inject hybridQuery as the Azure
// semantic search callable. Without this injection semanticChunks is always
// []. The wrapper projects HybridQueryResult.hits → SearchHit[] (note:
// the field is `hits`, NOT `results` — VERIFICATION.md prose typo).
import { hybridQuery } from '@kos/azure-search';

process.env.CLAUDE_CODE_USE_BEDROCK = '1';
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: 'eu-north-1' });

interface EBEvent {
  source: string;
  'detail-type': string;
  detail: unknown;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const dt = event['detail-type'];

    let captureId: string;
    let sourceKind: 'text' | 'voice';
    let text: string;
    let channel: 'telegram' | 'dashboard' = 'telegram';
    // Telegram-only — absent for dashboard-sourced captures. voice-capture
    // consults these downstream to decide whether to emit an output.push
    // Telegram reply ack (2026-04-24 widen).
    let senderId: number | undefined;
    let senderDisplay: string | undefined;
    let chatId: number | undefined;
    let messageId: number | undefined;

    if (dt === 'capture.received') {
      // Dispatch by `kind`. Chrome highlights and LinkedIn DMs share
      // `capture.received` with text captures but use different schemas
      // (channel='chrome'|'linkedin', extra fields). Map both to the
      // unified internal triage flow with channel='dashboard' downstream
      // (TriageRoutedSchema only accepts telegram/dashboard for now —
      // chrome/linkedin captures have no Telegram ack so 'dashboard' is
      // the right semantic equivalent).
      const detail = event.detail as { kind?: string };
      const kind = detail.kind;
      if (kind === 'chrome_highlight') {
        const d = CaptureReceivedChromeHighlightSchema.parse(event.detail);
        captureId = d.capture_id;
        sourceKind = 'text';
        text = d.text;
        channel = 'dashboard';
      } else if (kind === 'linkedin_dm') {
        const d = CaptureReceivedLinkedInDmSchema.parse(event.detail);
        captureId = d.capture_id;
        sourceKind = 'text';
        text = d.text ?? '';
        channel = 'dashboard';
      } else {
        const d = CaptureReceivedTextSchema.parse(event.detail);
        captureId = d.capture_id;
        sourceKind = 'text';
        text = d.text;
        channel = d.channel;
        senderId = d.sender?.id;
        senderDisplay = d.sender?.display;
        chatId = d.telegram?.chat_id;
        messageId = d.telegram?.message_id;
      }
    } else if (dt === 'capture.voice.transcribed') {
      const d = CaptureVoiceTranscribedSchema.parse(event.detail);
      captureId = d.capture_id;
      sourceKind = 'voice';
      text = d.text;
      senderId = d.sender.id;
      senderDisplay = d.sender.display;
      chatId = d.telegram.chat_id;
      messageId = d.telegram.message_id;
    } else {
      return { skipped: dt };
    }

    if (await findPriorOkRun(captureId, 'triage', ownerId)) {
      return { idempotent: captureId };
    }

    // Tag the active OTel span so all downstream Bedrock calls + child spans
    // share this capture_id as Langfuse session.id (cross-agent correlation).
    tagTraceWithCaptureId(captureId);

    const runId = await insertAgentRun({
      ownerId,
      captureId,
      agentName: 'triage',
      status: 'started',
    });

    try {
      // Phase 6 AGT-04: loadContext() replaces the Claude Agent SDK pre-call
      // hook. Returns a ContextBundle with Kevin Context + any matched entity
      // dossiers + Azure semantic chunks + linked projects. Empty entityIds
      // here — triage is the ROUTING step, entity resolution happens downstream.
      let contextMarkdown: string;
      try {
        const pool = await getPool();
        const bundle = await loadContext({
          entityIds: [],
          agentName: 'triage',
          captureId,
          ownerId,
          rawText: text,
          maxSemanticChunks: 6,
          pool,
          azureSearch: ({ rawText: rt, entityIds: eids, topK }) =>
            hybridQuery({ rawText: rt, entityIds: eids, topK }).then((r) => r.hits),
        });
        contextMarkdown = bundle.assembled_markdown;
      } catch (err) {
        // Degraded fallback: use the legacy Kevin-Context-only block so triage
        // still runs if @kos/context-loader / Azure Search / pg are impaired.
        console.warn('[triage] loadContext failed, falling back to Kevin Context only:', err);
        contextMarkdown = await loadKevinContextBlock(ownerId);
      }
      const { output, usage, rawText } = await runTriageAgent({
        captureId,
        sourceKind,
        text,
        senderDisplay,
        kevinContextBlock: contextMarkdown,
      });

      // Log raw LLM output immediately — invaluable for prompt tuning
      console.log('[triage] raw LLM output', { captureId, rawText });

      const routed = TriageRoutedSchema.parse({
        capture_id: captureId,
        source_kind: sourceKind,
        source_text: text.slice(0, 8000),
        channel,
        route: output.route,
        detected_type: output.detected_type,
        urgency: output.urgency,
        reason: output.reason,
        // Only forward the Telegram reply-target when it exists — dashboard
        // captures have no chat/message to reply to (voice-capture will skip
        // the output.push emit accordingly).
        ...(senderId !== undefined
          ? { sender: { id: senderId, display: senderDisplay } }
          : {}),
        ...(chatId !== undefined && messageId !== undefined
          ? { telegram: { chat_id: chatId, message_id: messageId } }
          : {}),
        routed_at: new Date().toISOString(),
      });

      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.triage',
              Source: 'kos.triage',
              DetailType: 'triage.routed',
              Detail: JSON.stringify(routed),
            },
          ],
        }),
      );

      await updateAgentRun(runId, {
        status: 'ok',
        outputJson: routed,
        tokensInput: usage.inputTokens,
        tokensOutput: usage.outputTokens,
      });

      return { routed: output.route };
    } catch (err) {
      await updateAgentRun(runId, { status: 'error', errorMessage: String(err) });
      throw err;
    }
  } finally {
    await langfuseFlush();
  }
});
