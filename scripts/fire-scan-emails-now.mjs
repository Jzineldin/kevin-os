#!/usr/bin/env node
/**
 * scripts/fire-scan-emails-now.mjs — operator on-demand AUTO-02 trigger.
 *
 * Emits a `kos.system / scan_emails_now` EventBridge event so the
 * email-triage Lambda processes the inbox immediately. Phase 7 ships an
 * EventBridge Scheduler that emits the same event every 2 hours
 * (cron(0 8/2 ? * MON-FRI *) Stockholm); this script is the manual
 * counterpart for ad-hoc operator runs.
 *
 * Usage:
 *   node scripts/fire-scan-emails-now.mjs
 *
 * Env:
 *   AWS_REGION         (defaults to eu-north-1)
 *   AWS_PROFILE        (defaults to whatever the AWS SDK picks up)
 *
 * Output: prints the capture_id so the operator can grep CloudWatch
 *         logs (`/aws/lambda/KosIntegrations-EmailTriage*`).
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';

const region = process.env.AWS_REGION ?? 'eu-north-1';
const eb = new EventBridgeClient({ region });
const captureId = ulid();
const requestedAt = new Date().toISOString();
const requestedBy = process.env.USER ?? 'operator';

const detail = {
  capture_id: captureId,
  requested_at: requestedAt,
  requested_by: requestedBy,
};

const r = await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        EventBusName: 'kos.system',
        Source: 'kos.system',
        DetailType: 'scan_emails_now',
        Detail: JSON.stringify(detail),
      },
    ],
  }),
);

if (r.FailedEntryCount && r.FailedEntryCount > 0) {
  console.error('PutEvents reported FailedEntryCount=', r.FailedEntryCount);
  console.error('Entries:', JSON.stringify(r.Entries, null, 2));
  process.exit(1);
}

console.log(`Emitted scan_emails_now capture_id=${captureId}`);
console.log('Tail CloudWatch /aws/lambda/KosIntegrations-EmailTriage* for results.');
