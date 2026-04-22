/**
 * transcribe-vocab-deploy — CloudFormation CustomResource handler.
 *
 * Delivers INF-08: AWS Transcribe custom vocabulary `kos-sv-se-v1` in phrase-only
 * format (RESEARCH Pitfall 7 — IPA/SoundsLike columns are deprecated for Swedish).
 *
 * Flow on Create/Update:
 *   1. Read the seed vocab file from the CDK Asset S3 bucket
 *      (`VOCAB_SEED_BUCKET` / `VOCAB_SEED_KEY`). Using the Asset avoids the
 *      cross-platform `cp -r` bundling which fails on Windows dev hosts.
 *   2. Strip `#`-prefixed comment lines and blank lines — the seed file carries
 *      documentation inline but Transcribe wants pure phrase lines.
 *   3. Re-upload the cleaned content to the canonical `VOCAB_BUCKET` / `VOCAB_S3_KEY`
 *      location so Kevin can mutate the vocab post-Phase-1 by overwriting that
 *      S3 key directly (no CDK redeploy needed — just bump `contentHash`).
 *   4. Probe for existing vocabulary. If exists → `UpdateVocabulary`; else
 *      `CreateVocabulary`. Both pass `LanguageCode: sv-SE` explicitly. Do NOT
 *      use Transcribe auto-language-id (Anti-Pattern per RESEARCH line 608 —
 *      Swedish is not in the auto-id supported-languages matrix).
 *   5. Poll `GetVocabulary` every 10s until state = `READY` (success) or
 *      `FAILED` (throw). Hard deadline = 5 minutes per plan must-haves.
 *
 * Flow on Delete:
 *   - Archive-not-delete: return the PhysicalResourceId without calling
 *     `DeleteVocabulary`. CloudFormation drops its reference; the vocabulary
 *     remains so Phase 2 consumers can keep using it even during stack churn.
 *     Operator can delete out-of-band with `aws transcribe delete-vocabulary`.
 */
import {
  TranscribeClient,
  CreateVocabularyCommand,
  UpdateVocabularyCommand,
  GetVocabularyCommand,
} from '@aws-sdk/client-transcribe';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const VOCAB_NAME = 'kos-sv-se-v1';
const LANG = 'sv-SE';
const POLL_INTERVAL_MS = 10_000;
const POLL_DEADLINE_MS = 5 * 60 * 1000;

export interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties?: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

export interface CustomResourceResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

export interface HandlerDeps {
  transcribe?: TranscribeClient;
  s3?: S3Client;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove `#`-prefixed comment lines and blank lines from the seed vocab content.
 * Transcribe expects one phrase per line; our checked-in seed file mixes in
 * documentation for Kevin's benefit.
 */
export function stripCommentsAndBlanks(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join('\n');
}

export async function handler(
  event: CustomResourceEvent,
  deps: HandlerDeps = {},
): Promise<CustomResourceResponse> {
  const region = requireEnv('TRANSCRIBE_REGION');
  const bucket = requireEnv('VOCAB_BUCKET');
  const s3Key = requireEnv('VOCAB_S3_KEY');
  const seedBucket = requireEnv('VOCAB_SEED_BUCKET');
  const seedKey = requireEnv('VOCAB_SEED_KEY');

  const transcribe = deps.transcribe ?? new TranscribeClient({ region });
  const s3 = deps.s3 ?? new S3Client({ region });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  if (event.RequestType === 'Delete') {
    // Archive-not-delete: preserve the vocabulary on stack delete. Phase 2
    // voice consumers reference it by name; keeping it alive across stack
    // churn avoids accidental data loss.
    //
    // Echo back the incoming PhysicalResourceId so CloudFormation never sees
    // the ID change between CREATE and DELETE (which otherwise triggers
    // `cannot change the physical resource ID from X to Y during deletion`
    // and traps the stack in DELETE_FAILED — see 2026-04-22 retro).
    return { PhysicalResourceId: event.PhysicalResourceId ?? VOCAB_NAME };
  }

  // 1 + 2: fetch seed + strip comments/blanks.
  const seedObj = await s3.send(
    new GetObjectCommand({ Bucket: seedBucket, Key: seedKey }),
  );
  if (!seedObj.Body) {
    throw new Error(`Seed vocab object ${seedBucket}/${seedKey} returned empty body`);
  }
  const rawContent = await seedObj.Body.transformToString('utf-8');
  const cleanContent = stripCommentsAndBlanks(rawContent);
  if (cleanContent.length === 0) {
    throw new Error('Seed vocab is empty after stripping comments');
  }

  // 3: upload canonical file.
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: cleanContent,
      ContentType: 'text/plain; charset=utf-8',
    }),
  );

  const s3Uri = `s3://${bucket}/${s3Key}`;

  // 4: create-or-update.
  const exists = await vocabularyExists(transcribe);
  if (exists) {
    await transcribe.send(
      new UpdateVocabularyCommand({
        VocabularyName: VOCAB_NAME,
        LanguageCode: LANG,
        VocabularyFileUri: s3Uri,
      }),
    );
  } else {
    await transcribe.send(
      new CreateVocabularyCommand({
        VocabularyName: VOCAB_NAME,
        LanguageCode: LANG,
        VocabularyFileUri: s3Uri,
      }),
    );
  }

  // 5: poll to READY.
  const deadline = now() + POLL_DEADLINE_MS;
  while (now() < deadline) {
    const v = await transcribe.send(
      new GetVocabularyCommand({ VocabularyName: VOCAB_NAME }),
    );
    if (v.VocabularyState === 'READY') {
      return {
        PhysicalResourceId: VOCAB_NAME,
        Data: { vocabularyName: VOCAB_NAME, vocabularyState: 'READY' },
      };
    }
    if (v.VocabularyState === 'FAILED') {
      throw new Error(
        `Vocabulary ${VOCAB_NAME} FAILED: ${v.FailureReason ?? 'no reason returned'}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Vocabulary ${VOCAB_NAME} did not reach READY within ${POLL_DEADLINE_MS / 1000}s`,
  );
}

async function vocabularyExists(transcribe: TranscribeClient): Promise<boolean> {
  try {
    await transcribe.send(new GetVocabularyCommand({ VocabularyName: VOCAB_NAME }));
    return true;
  } catch (e) {
    const err = e as { name?: string };
    // Transcribe GetVocabulary returns BadRequestException when the named
    // vocabulary doesn't exist (SDK v3 maps "NotFoundException" in some
    // regions — accept both and rethrow anything else).
    if (err.name === 'BadRequestException' || err.name === 'NotFoundException') {
      return false;
    }
    throw e;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}
