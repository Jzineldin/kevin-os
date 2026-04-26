/**
 * S3 put helper for Baileys WhatsApp voice audio (Plan 05-05 / CAP-06).
 *
 * Mirrors services/telegram-bot/src/s3.ts — same `audio/{YYYY}/{MM}/{ULID}.{ext}`
 * shape, no user-controlled path components (T-05-05-02 mitigation). Voice
 * notes from WhatsApp are always Opus-in-Ogg (`audio/ogg; codecs=opus`); we
 * also accept any mimetype containing `opus`/`ogg` defensively. Anything
 * else falls back to `.bin`.
 *
 * The existing Phase-2 transcribe-starter Lambda has an S3 trigger on the
 * `audio/*` prefix in this same bucket — voice notes routed through this
 * helper auto-fire transcription with zero further wiring.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-north-1' });

export async function putAudio(
  captureId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bucket: string; key: string }> {
  const bucket = process.env.BLOBS_BUCKET;
  if (!bucket) throw new Error('BLOBS_BUCKET env var not set');
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const lower = mimeType.toLowerCase();
  const ext = lower.includes('opus') || lower.includes('ogg') ? 'ogg' : 'bin';
  const key = `audio/${yyyy}/${mm}/${captureId}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: mimeType,
      Metadata: {
        capture_id: captureId,
        channel: 'whatsapp',
      },
    }),
  );
  return { bucket, key };
}

/** Test-only — re-export the underlying S3 client so tests can spy on `send`. */
export { s3 as __s3ClientForTests };
