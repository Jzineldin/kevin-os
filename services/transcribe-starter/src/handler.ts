/**
 * @kos/service-transcribe-starter — INF-08 / Plan 02-02 Task 1.
 *
 * Triggered by EventBridge rule on `kos.capture` (source=kos.capture,
 * detail-type=capture.received, detail.kind=voice). Starts an AWS Transcribe
 * job for the Telegram-uploaded OGG/Opus blob, using the Phase 1 deployed
 * `kos-sv-se-v1` custom vocabulary. Idempotent on the unique
 * `kos-${capture_id}` job name (Transcribe rejects duplicates with
 * ConflictException — swallowed as success).
 *
 * Pitfall 13 (region pin): TranscribeClient is hard-pinned to `eu-north-1`,
 * NEVER `process.env.AWS_REGION`. The vocabulary is regional and only exists
 * in eu-north-1; cross-region invocation produces a "BadRequest: Vocabulary
 * not found" error. Pinning at the SDK layer prevents the entire Lambda from
 * accidentally being deployed to a different region with this oversight.
 */
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { init as sentryInit, wrapHandler } from '@sentry/aws-serverless';
import { CaptureReceivedVoiceSchema } from '@kos/contracts';
import type { EventBridgeEvent } from 'aws-lambda';

sentryInit({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  sampleRate: 1,
});

// Pitfall 13: pin region explicitly; never env.AWS_REGION fallback — vocab is eu-north-1.
const client = new TranscribeClient({ region: 'eu-north-1' });

const VOCAB_NAME = 'kos-sv-se-v1'; // Phase 1 Plan 06 deployed, State=READY
const LANGUAGE_CODE = 'sv-SE';

interface ConflictLike {
  name?: string;
}

export const handler = wrapHandler(
  async (
    event: EventBridgeEvent<'capture.received', unknown>,
  ): Promise<{ started: string; idempotentHit?: boolean } | { skipped: true }> => {
    const detail = CaptureReceivedVoiceSchema.parse(event.detail);
    if (detail.kind !== 'voice') return { skipped: true }; // safety: rule filter already narrows this
    const jobName = `kos-${detail.capture_id}`; // ULID makes this idempotent (Transcribe rejects duplicate names)
    try {
      await client.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: LANGUAGE_CODE,
          Media: {
            MediaFileUri: `s3://${detail.raw_ref.s3_bucket}/${detail.raw_ref.s3_key}`,
          },
          MediaFormat: 'ogg', // Telegram voice is always OGG Opus
          OutputBucketName: detail.raw_ref.s3_bucket,
          OutputKey: `transcripts/${detail.capture_id}.json`,
          Settings: { VocabularyName: VOCAB_NAME },
        }),
      );
      return { started: jobName };
    } catch (err) {
      // ConflictException (duplicate job name) = already started; safe to swallow (idempotent)
      if ((err as ConflictLike).name === 'ConflictException') {
        return { started: jobName, idempotentHit: true };
      }
      throw err;
    }
  },
);
