#!/usr/bin/env node
/**
 * scripts/submit-content-topic.mjs — operator trigger for AGT-07
 *   (Plan 08-02 Task 3).
 *
 * Emits a `kos.agent / content.topic_submitted` EventBridge event so the
 * content-writer orchestrator Lambda starts the
 * `kos-content-writer-5platform` Step Functions Map state machine. Use this
 * when iterating on prompts / brand voice without going through Telegram or
 * the dashboard.
 *
 * Usage:
 *   node scripts/submit-content-topic.mjs --text "Write about Almi signing"
 *   node scripts/submit-content-topic.mjs --text "..." --platforms ig,linkedin
 *   node scripts/submit-content-topic.mjs --text "..." --capture-id <existing-ulid>
 *
 * Platform shorthand: `ig` → `instagram`. All other values pass through
 * unchanged; the Zod schema in @kos/contracts rejects unknown platforms.
 *
 * Env:
 *   AWS_REGION   defaults to eu-north-1
 *   AWS_PROFILE  defaults to whatever the SDK picks up
 *
 * The script prints the topic_id + capture_id + execution-arn discovery
 * hint so the operator can grep CloudWatch:
 *   /aws/stepfunctions/kos-content-writer-5platform
 *   /aws/lambda/KosIntegrations-ContentWriter*
 *   /aws/lambda/KosIntegrations-ContentWriterPlatform*
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';

const argv = process.argv.slice(2);
const textIdx = argv.indexOf('--text');
if (textIdx === -1 || !argv[textIdx + 1]) {
  console.error(
    'usage: --text "<topic>" [--platforms ig,linkedin,tiktok,reddit,newsletter] [--capture-id <ulid>]',
  );
  process.exit(2);
}
const topicText = argv[textIdx + 1];

const platformsArg = argv.indexOf('--platforms');
const platforms =
  platformsArg === -1
    ? ['instagram', 'linkedin', 'tiktok', 'reddit', 'newsletter']
    : argv[platformsArg + 1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p === 'ig' ? 'instagram' : p));

const captureArg = argv.indexOf('--capture-id');
const captureId = captureArg === -1 ? ulid() : argv[captureArg + 1];
const topicId = ulid();
const submittedAt = new Date().toISOString();

const region = process.env.AWS_REGION ?? 'eu-north-1';
const eb = new EventBridgeClient({ region });

const detail = {
  topic_id: topicId,
  capture_id: captureId,
  topic_text: topicText,
  platforms,
  submitted_at: submittedAt,
};

const r = await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        EventBusName: 'kos.agent',
        Source: 'kos.agent',
        DetailType: 'content.topic_submitted',
        Detail: JSON.stringify(detail),
      },
    ],
  }),
);

if (r.FailedEntryCount && r.FailedEntryCount > 0) {
  console.error('PutEvents reported FailedEntryCount > 0:', JSON.stringify(r.Entries));
  process.exit(1);
}

console.log(
  `Emitted content.topic_submitted topic_id=${topicId} capture_id=${captureId} platforms=${platforms.join(',')}`,
);
console.log(
  'Tail /aws/stepfunctions/kos-content-writer-5platform and /aws/lambda/KosIntegrations-ContentWriter* for output.',
);
