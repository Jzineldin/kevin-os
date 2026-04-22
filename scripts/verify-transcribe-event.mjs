#!/usr/bin/env node
// verify-transcribe-event.mjs -- Plan 02-02 operator verification.
//
// Usage: AWS_REGION=eu-north-1 BLOBS_BUCKET=<name> \
//   [VERIFY_OGG_PATH=fixtures/silence-3s.oga] \
//   node scripts/verify-transcribe-event.mjs [capture_id]
//
// Purpose: exercise the voice pipeline end-to-end against a deployed
// KosCapture stack WITHOUT requiring Telegram. Uploads a tiny OGG blob +
// meta sidecar, publishes capture.received (kind=voice) to kos.capture,
// then polls AWS Transcribe for the kos-${capture_id} job until COMPLETED.
//
// Deferred to operator -- requires:
//   * KosCapture stack deployed
//   * BLOBS_BUCKET env var (name of the data-stack blobs bucket)
//   * VERIFY_OGG_PATH pointing at a real short OGG/Opus file (the
//     `fixtures/silence-3s.oga` path is a convenience default)
//   * AWS credentials with PutObject + PutEvents + GetTranscriptionJob
//
// Full triage + Notion E2E lives in scripts/verify-phase-2-e2e.mjs (Plan 11).

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  TranscribeClient,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { readFile } from 'node:fs/promises';
import { ulid } from 'ulid';

const region = process.env.AWS_REGION ?? 'eu-north-1';
const s3 = new S3Client({ region });
const eb = new EventBridgeClient({ region });
const tr = new TranscribeClient({ region });

const captureId = process.argv[2] ?? ulid();
const bucket = process.env.BLOBS_BUCKET;
if (!bucket) {
  console.error('BLOBS_BUCKET env required');
  process.exit(1);
}

const oggPath = process.env.VERIFY_OGG_PATH ?? 'fixtures/silence-3s.oga';
let bytes;
try {
  bytes = await readFile(oggPath);
} catch (err) {
  console.error(`Could not read ${oggPath}: ${err.message}`);
  console.error('Set VERIFY_OGG_PATH to a real OGG/Opus file.');
  process.exit(1);
}

const now = new Date();
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const audioKey = `audio/${yyyy}/${mm}/${captureId}.oga`;
const metaKey = `audio/meta/${captureId}.json`;

console.log(`[1/4] PUT audio → s3://${bucket}/${audioKey}`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: audioKey,
    Body: bytes,
    ContentType: 'audio/ogg',
  }),
);

console.log(`[2/4] PUT meta → s3://${bucket}/${metaKey}`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: metaKey,
    ContentType: 'application/json',
    Body: JSON.stringify({
      raw_ref: {
        s3_bucket: bucket,
        s3_key: audioKey,
        duration_sec: 3,
        mime_type: 'audio/ogg',
      },
      sender: { id: 111222333, display: 'Kevin' },
      received_at: now.toISOString(),
      telegram: { chat_id: 111222333, message_id: 1 },
    }),
  }),
);

console.log(`[3/4] PutEvents kos.capture / capture.received / kind=voice`);
await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        EventBusName: 'kos.capture',
        Source: 'kos.capture',
        DetailType: 'capture.received',
        Detail: JSON.stringify({
          capture_id: captureId,
          channel: 'telegram',
          kind: 'voice',
          raw_ref: {
            s3_bucket: bucket,
            s3_key: audioKey,
            duration_sec: 3,
            mime_type: 'audio/ogg',
          },
          sender: { id: 111222333, display: 'Kevin' },
          received_at: now.toISOString(),
          telegram: { chat_id: 111222333, message_id: 1 },
        }),
      },
    ],
  }),
);

const jobName = `kos-${captureId}`;
console.log(`[4/4] polling GetTranscriptionJob(${jobName}) up to 90s…`);
const started = Date.now();
const deadline = started + 90_000;
let status = 'UNKNOWN';
while (Date.now() < deadline) {
  try {
    const job = await tr.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    status = job.TranscriptionJob?.TranscriptionJobStatus ?? 'UNKNOWN';
    if (status === 'COMPLETED' || status === 'FAILED') break;
  } catch {
    // job not yet registered; keep polling
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const elapsed = Date.now() - started;
console.log(`[${status}] job=${jobName} duration_ms=${elapsed}`);
if (status !== 'COMPLETED') {
  process.exit(1);
}
console.log(`[OK] capture_id=${captureId}`);
