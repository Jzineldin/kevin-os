/**
 * @kos/service-transcribe-complete — INF-08 / Plan 02-02 Task 1.
 *
 * Triggered by EventBridge rule on the default bus
 * (source=aws.transcribe, detail-type='Transcribe Job State Change',
 * detail.TranscriptionJobName prefix `kos-`). Reads the transcript JSON
 * Transcribe wrote to S3, hydrates the original capture metadata from a
 * sidecar `audio/meta/{capture_id}.json` blob (telegram-bot writes this on
 * every voice ingestion), and emits `capture.voice.transcribed` to the
 * `kos.capture` bus for the triage / voice-capture agents.
 *
 * Pitfall 2 (~100-500ms race between Transcribe completion event and S3
 * object availability): `readTranscriptWithRetry` retries once on
 * NoSuchKey/NotFound after a 500ms backoff before giving up.
 *
 * Pitfall 13 (region pin): All three SDK clients are hard-pinned to
 * `eu-north-1`; never `process.env.AWS_REGION`.
 *
 * On TranscriptionJobStatus=FAILED, emits `transcribe.failed` to `kos.system`
 * (Plan 10 observability surface) instead of `capture.voice.transcribed`.
 */
import {
  TranscribeClient,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { init as sentryInit, wrapHandler } from '@sentry/aws-serverless';
import type { EventBridgeEvent } from 'aws-lambda';

sentryInit({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  sampleRate: 1,
});

const transcribe = new TranscribeClient({ region: 'eu-north-1' });
const s3 = new S3Client({ region: 'eu-north-1' });
const eb = new EventBridgeClient({ region: 'eu-north-1' });

export interface TranscribeStateChangeDetail {
  TranscriptionJobName: string;
  TranscriptionJobStatus: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'QUEUED';
  FailureReason?: string;
  LanguageCode?: string;
}

interface ErrLike {
  name?: string;
  Code?: string;
}

async function readTranscriptWithRetry(
  bucket: string,
  key: string,
): Promise<string> {
  // Pitfall 2: ~100-500ms race between event and S3 object availability.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const body = await obj.Body?.transformToString();
      if (!body) throw new Error('empty transcript body');
      const parsed = JSON.parse(body) as {
        results?: { transcripts?: { transcript?: string }[] };
      };
      const text = parsed.results?.transcripts?.[0]?.transcript;
      if (typeof text !== 'string') throw new Error('transcript JSON malformed');
      return text;
    } catch (err) {
      const e = err as ErrLike;
      const code = e.name ?? e.Code;
      if (
        attempt === 0 &&
        (code === 'NoSuchKey' || code === 'NotFound' || code === '404')
      ) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }
  throw new Error('readTranscriptWithRetry exhausted');
}

interface VoiceMetaSidecar {
  raw_ref: {
    s3_bucket: string;
    s3_key: string;
    duration_sec: number;
    mime_type: string;
  };
  sender: { id: number; display?: string };
  received_at: string;
  telegram: { chat_id: number; message_id: number };
}

export const handler = wrapHandler(
  async (
    event: EventBridgeEvent<'Transcribe Job State Change', TranscribeStateChangeDetail>,
  ): Promise<{ published?: string; failed?: string; skipped?: string }> => {
    const detail = event.detail;
    const jobName = detail.TranscriptionJobName;
    if (!jobName.startsWith('kos-')) return { skipped: 'not-a-kos-job' };

    const capture_id = jobName.slice('kos-'.length);

    if (detail.TranscriptionJobStatus === 'FAILED') {
      // Publish failure to kos.system so Plan 10 observability surfaces it.
      await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: 'kos.system',
              Source: 'kos.system',
              DetailType: 'transcribe.failed',
              Detail: JSON.stringify({
                capture_id,
                reason: detail.FailureReason ?? 'unknown',
              }),
            },
          ],
        }),
      );
      return { failed: capture_id };
    }

    if (detail.TranscriptionJobStatus !== 'COMPLETED') {
      return { skipped: detail.TranscriptionJobStatus };
    }

    // Retrieve job to get the canonical TranscriptFileUri (the EventBridge
    // event shape doesn't always echo Output{Bucket,Key}).
    const job = await transcribe.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    const outputUri = job.TranscriptionJob?.Transcript?.TranscriptFileUri ?? '';
    // Format: s3://<bucket>/<key>  OR  https://s3.<region>.amazonaws.com/<bucket>/<key>
    const s3Match =
      outputUri.match(/^s3:\/\/([^/]+)\/(.+)$/) ??
      outputUri.match(
        /^https:\/\/s3[^/]*\.amazonaws\.com\/([^/]+)\/(.+)$/,
      );
    if (!s3Match)
      throw new Error(`cannot parse TranscriptFileUri: ${outputUri}`);
    const bucket = s3Match[1] as string;
    const key = s3Match[2] as string;

    const text = await readTranscriptWithRetry(bucket, key);

    // Hydrate the downstream event payload from the sidecar telegram-bot
    // wrote next to the audio blob (Task 1 also modifies telegram-bot to
    // emit `audio/meta/{capture_id}.json`). This is the only way to
    // reconstruct chat_id / message_id / sender without passing state
    // through Transcribe, which doesn't carry user metadata.
    const blobsBucket = process.env.BLOBS_BUCKET;
    if (!blobsBucket) throw new Error('BLOBS_BUCKET env var not set');
    const metaKey = `audio/meta/${capture_id}.json`;
    const metaObj = await s3.send(
      new GetObjectCommand({ Bucket: blobsBucket, Key: metaKey }),
    );
    const metaBody = await metaObj.Body?.transformToString();
    if (!metaBody) throw new Error(`empty meta sidecar at ${metaKey}`);
    const meta = JSON.parse(metaBody) as VoiceMetaSidecar;

    const published = {
      capture_id,
      channel: 'telegram' as const,
      kind: 'voice' as const,
      text,
      raw_ref: meta.raw_ref,
      sender: meta.sender,
      received_at: meta.received_at,
      transcribed_at: new Date().toISOString(),
      telegram: meta.telegram,
      vocab_name: 'kos-sv-se-v1' as const,
    };
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: 'kos.capture',
            Source: 'kos.capture',
            DetailType: 'capture.voice.transcribed',
            Detail: JSON.stringify(published),
          },
        ],
      }),
    );
    return { published: capture_id };
  },
);
