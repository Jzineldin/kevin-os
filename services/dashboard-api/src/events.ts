/**
 * EventBridge publisher — thin typed wrappers around PutEvents.
 *
 * Two buses are referenced:
 *  - `kos.capture`  — inbound capture pipeline (reuses Phase 2 Triage Lambda).
 *  - `kos.output`   — outbound system signals (SSE fan-out via dashboard-listen-relay).
 *
 * The 5 `kos.output` detail-types match D-25 SSE kinds verbatim.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

let client: EventBridgeClient | null = null;

function getClient(): EventBridgeClient {
  if (client) return client;
  client = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return client;
}

export async function publishCapture(detail: object): Promise<void> {
  await getClient().send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'kos.capture',
          DetailType: 'capture.received',
          Detail: JSON.stringify(detail),
          EventBusName: 'kos.capture',
        },
      ],
    }),
  );
}

export type OutputDetailType =
  | 'inbox_item'
  | 'entity_merge'
  | 'capture_ack'
  | 'draft_ready'
  | 'timeline_event'
  // Phase 4 Plan 04-05: dashboard Approve / Edit / Skip routes emit these.
  // `email.approved` is the trigger consumed by the email-sender Lambda;
  // `draft_edited` + `draft_skipped` are SSE-only signals for the dashboard.
  | 'email.approved'
  | 'draft_edited'
  | 'draft_skipped';

export async function publishOutput(
  detailType: OutputDetailType,
  detail: object,
): Promise<void> {
  await getClient().send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'kos.dashboard',
          DetailType: detailType,
          Detail: JSON.stringify(detail),
          EventBusName: 'kos.output',
        },
      ],
    }),
  );
}

/**
 * Plan 04-05 publisher used by the Approve / Edit / Skip route handlers.
 *
 * The email-sender Lambda's EventBridge rule filters on
 * `source=['kos.output'] AND detailType=['email.approved']` — that's
 * structurally narrower than the dashboard's normal `kos.dashboard`
 * source, so the rule cannot accidentally fire on user-edit / skip
 * events. We always emit with Source='kos.output' for these three
 * detail-types and rely on the rule's source filter.
 */
export async function publishApproveGateEvent(
  detailType: 'email.approved' | 'draft_edited' | 'draft_skipped',
  detail: object,
): Promise<void> {
  await getClient().send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'kos.output',
          DetailType: detailType,
          Detail: JSON.stringify(detail),
          EventBusName: 'kos.output',
        },
      ],
    }),
  );
}

/** Test seam — let Vitest inject a mocked client. Production never calls. */
export function __setEventsClientForTest(fake: EventBridgeClient | null): void {
  client = fake;
}
