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
