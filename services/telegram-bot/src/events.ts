/**
 * EventBridge PutEvents wrapper for `kos.capture` / `capture.received`.
 *
 * D-04: capture Lambdas MUST NOT call agents directly — only publish to the
 * capture bus. Downstream routing (triage -> voice-capture, etc.) is handled
 * by EventBridge rules (Plan 02-04+).
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

const eb = new EventBridgeClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

export async function publishCaptureReceived(detail: unknown): Promise<void> {
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: 'kos.capture',
          Source: 'kos.capture',
          DetailType: 'capture.received',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}
