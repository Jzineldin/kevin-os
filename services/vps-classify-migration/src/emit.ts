/**
 * EventBridge `capture.received` emitter for the VPS classify-adapter (MIG-01).
 *
 * The adapter is a thin pass-through during the 14-day decom overlap (D-23 +
 * G-01): the legacy VPS `classify_and_save.py` script accepts arbitrary
 * keyword args, so the adapter relays whatever payload it receives onto the
 * `kos.capture` EventBridge bus with a distinct `Source` so the Phase-2
 * triage Lambda's existing rule (which filters on `Source = 'kos.capture'`
 * + canonical `CaptureReceivedTextSchema` shape) does NOT pick it up.
 *
 * Why a separate Source?
 *   - Phase 2 triage parses the detail through `CaptureReceivedTextSchema`
 *     which constrains `channel` to `'telegram' | 'dashboard'`. The adapter
 *     payload is open-shape (passthrough) and would Zod-fail there.
 *   - The audit value of the adapter is the EventBridge event row itself —
 *     `scripts/verify-classify-substance.mjs` reads the EB CloudWatch
 *     metrics + the Notion Legacy Inbox rows that the freeze-redirected VPS
 *     script also writes, then asks Gemini 2.5 Pro to score equivalence.
 *   - Plan 10-07 turns the bus consumer ON only after Kevin signs off.
 *
 * Detail shape (intentionally NOT a Zod-schema in @kos/contracts so future
 * VPS-side payload changes do not require a contracts release):
 *   {
 *     capture_id:  string (ULID, server-minted)
 *     source:      'vps-classify-migration-adapter'
 *     emitted_at:  ISO timestamp
 *     raw:         <original passthrough payload>
 *   }
 *
 * The handler lays this on the bus once per validated request; if the
 * PutEvents call fails (network, throttle), the failure bubbles to the
 * handler so Sentry captures it AND the VPS caller sees a 5xx → its
 * existing retry loop handles redelivery.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

/** What the adapter actually emits as the EB detail body. */
export interface CaptureReceivedAdapterDetail {
  capture_id: string;
  source: 'vps-classify-migration-adapter';
  emitted_at: string;
  raw: unknown;
}

export interface EmitDeps {
  eb: EventBridgeClient;
  busName: string;
}

export interface EmitInput {
  capture_id: string;
  raw: unknown;
  /** Override `Date.now()` for deterministic tests. */
  emitted_at?: string;
}

/**
 * Publish one `capture.received` event onto the `kos.capture` bus.
 *
 * @throws on PutEvents failure or any FailedEntryCount > 0 in the response —
 *         the handler converts this into a 5xx so the VPS caller retries.
 */
export async function emitCaptureReceived(
  deps: EmitDeps,
  input: EmitInput,
): Promise<{ detail: CaptureReceivedAdapterDetail }> {
  const detail: CaptureReceivedAdapterDetail = {
    capture_id: input.capture_id,
    source: 'vps-classify-migration-adapter',
    emitted_at: input.emitted_at ?? new Date().toISOString(),
    raw: input.raw,
  };

  const r = await deps.eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: deps.busName,
          // Distinct from the Phase-2 `kos.capture` Source so triage's
          // EventBridge rule does NOT route the adapter event into the
          // Phase-2 Haiku 4.5 path during the migration overlap.
          Source: 'kos.capture-migration-adapter',
          DetailType: 'capture.received',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );

  if ((r.FailedEntryCount ?? 0) > 0) {
    const errEntry = (r.Entries ?? []).find(
      (e) => e.ErrorCode || e.ErrorMessage,
    );
    throw new Error(
      `vps-classify-migration: PutEvents FailedEntryCount=${r.FailedEntryCount} ${
        errEntry?.ErrorCode ?? 'unknown'
      }: ${errEntry?.ErrorMessage ?? 'no message'}`,
    );
  }

  return { detail };
}
