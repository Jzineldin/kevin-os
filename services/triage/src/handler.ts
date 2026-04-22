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
import { init as sentryInit, wrapHandler } from '@sentry/aws-serverless';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CaptureReceivedTextSchema,
  CaptureVoiceTranscribedSchema,
  TriageRoutedSchema,
} from '@kos/contracts';
import { setupOtelTracing, flush as langfuseFlush } from '../../_shared/tracing.js';
import { runTriageAgent } from './agent.js';
import {
  findPriorOkRun,
  insertAgentRun,
  updateAgentRun,
  loadKevinContextBlock,
} from './persist.js';

sentryInit({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0, sampleRate: 1 });
setupOtelTracing();
process.env.CLAUDE_CODE_USE_BEDROCK = '1';
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: 'eu-north-1' });

interface EBEvent {
  source: string;
  'detail-type': string;
  detail: unknown;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const dt = event['detail-type'];

    let captureId: string;
    let sourceKind: 'text' | 'voice';
    let text: string;
    let senderId: number;
    let senderDisplay: string | undefined;
    let chatId: number;
    let messageId: number;

    if (dt === 'capture.received') {
      const d = CaptureReceivedTextSchema.parse(event.detail);
      captureId = d.capture_id;
      sourceKind = 'text';
      text = d.text;
      senderId = d.sender.id;
      senderDisplay = d.sender.display;
      chatId = d.telegram.chat_id;
      messageId = d.telegram.message_id;
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

    const runId = await insertAgentRun({
      ownerId,
      captureId,
      agentName: 'triage',
      status: 'started',
    });

    try {
      const kevinContextBlock = await loadKevinContextBlock(ownerId);
      const { output, usage } = await runTriageAgent({
        captureId,
        sourceKind,
        text,
        senderDisplay,
        kevinContextBlock,
      });

      const routed = TriageRoutedSchema.parse({
        capture_id: captureId,
        source_kind: sourceKind,
        source_text: text.slice(0, 8000),
        route: output.route,
        detected_type: output.detected_type,
        urgency: output.urgency,
        reason: output.reason,
        sender: { id: senderId, display: senderDisplay },
        telegram: { chat_id: chatId, message_id: messageId },
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
