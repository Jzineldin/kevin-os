/**
 * S3 put helper for Telegram voice audio (CAP-01).
 *
 * Key shape: `audio/{YYYY}/{MM}/{ULID}.{ext}` — no user-controlled path
 * components (T-02-S3-01 mitigation). Telegram voice is always audio/ogg
 * (Opus); unknown mime types fall back to `.bin`.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-north-1' });

export async function putVoiceAudio(
  captureId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bucket: string; key: string }> {
  const bucket = process.env.BLOBS_BUCKET;
  if (!bucket) throw new Error('BLOBS_BUCKET env var not set');
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = mimeType === 'audio/ogg' ? 'oga' : 'bin';
  const key = `audio/${yyyy}/${mm}/${captureId}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: mimeType,
    }),
  );
  return { bucket, key };
}

/**
 * Writes a JSON sidecar at `audio/meta/{captureId}.json` holding the capture
 * metadata (raw_ref, sender, received_at, telegram fields). Plan 02-02's
 * transcribe-complete Lambda reads this to reconstruct the downstream
 * `capture.voice.transcribed` event — Transcribe itself doesn't carry
 * user/chat context through its completion event.
 *
 * Key shape is fully deterministic (captureId only) and has no
 * user-controlled path components (T-02-S3-01 / T-02-TRANSCRIBE-03).
 */
export async function putVoiceMeta(
  captureId: string,
  meta: unknown,
): Promise<void> {
  const bucket = process.env.BLOBS_BUCKET;
  if (!bucket) throw new Error('BLOBS_BUCKET env var not set');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `audio/meta/${captureId}.json`,
      Body: JSON.stringify(meta),
      ContentType: 'application/json',
    }),
  );
}
