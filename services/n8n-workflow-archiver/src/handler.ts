/**
 * @kos/service-n8n-workflow-archiver — MIG-02 n8n workflow archive Lambda.
 *
 * Reads an array of n8n workflow exports (JSON), canonicalizes each one
 * (deterministic key ordering so the SHA-256 is stable regardless of the
 * key insertion order n8n's exporter happens to use today), writes a
 * KMS-encrypted object to S3 under `${s3Prefix}/<workflow_id>.json`, and
 * returns one `{ workflow_id, sha256, s3_key }` row per archived
 * workflow.
 *
 * Behaviour ships in Wave 0 because:
 *   - the plan's `done` criterion calls for a passing 3-case archiver test,
 *   - the canonicalization + SHA-256 logic is deterministic + side-effect
 *     free with the AWS clients injectable, so it lands cleanly without
 *     waiting for Wave 1+ wiring.
 *
 * Threat mitigations:
 *   T-10-02-01 (Tamper): SHA-256 written into the archive index makes any
 *     post-archive mutation detectable. KMS encryption protects the
 *     blob-at-rest.
 *   T-10-02-02 (Drift): canonical JSON key sort makes the digest stable
 *     across re-exports of an unchanged workflow.
 */
import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface N8nWorkflow {
  id: string;
  name?: string;
  // n8n exports include `nodes`, `connections`, `settings`, etc. We intentionally
  // accept arbitrary additional fields so the archiver handles new n8n
  // schema versions without code change.
  [key: string]: unknown;
}

export interface ArchiveInput {
  /** Array of raw workflow JSON objects (one per workflow). */
  workflows: N8nWorkflow[];
  /** S3 key prefix — written objects land at `${s3Prefix}/<workflow_id>.json`. */
  s3Prefix: string;
  /** S3 bucket name; defaults to `process.env.ARCHIVE_BUCKET_NAME`. */
  bucketName?: string;
  /** KMS key id for SSE-KMS; defaults to `process.env.KMS_KEY_ID`. */
  kmsKeyId?: string;
  /** Optional override — primarily for tests with `aws-sdk-client-mock`. */
  s3?: S3Client;
}

export interface ArchiveResultRow {
  workflow_id: string;
  sha256: string;
  s3_key: string;
}

export interface ArchiveResult {
  archived: ArchiveResultRow[];
}

/**
 * Recursive canonical JSON encoder — sorts every object's keys
 * alphabetically and emits a string with no whitespace. Arrays preserve
 * order (n8n connection order is semantically meaningful). Numbers, bools,
 * and strings round-trip via `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * SHA-256 over the canonicalized JSON. Hex-encoded.
 */
export function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function getBucket(input: ArchiveInput): string {
  const b = input.bucketName ?? process.env.ARCHIVE_BUCKET_NAME;
  if (!b) {
    throw new Error(
      'n8n-workflow-archiver: ARCHIVE_BUCKET_NAME env var (or bucketName option) is required',
    );
  }
  return b;
}

function getKmsKey(input: ArchiveInput): string {
  const k = input.kmsKeyId ?? process.env.KMS_KEY_ID;
  if (!k) {
    throw new Error(
      'n8n-workflow-archiver: KMS_KEY_ID env var (or kmsKeyId option) is required',
    );
  }
  return k;
}

/**
 * Strip a leading slash and append a trailing slash to the prefix so
 * `${prefix}<id>.json` always resolves to a tidy key.
 */
function normalizePrefix(prefix: string): string {
  let p = prefix.replace(/^\/+/, '');
  if (p.length > 0 && !p.endsWith('/')) p += '/';
  return p;
}

/**
 * Lambda handler. Either invoke with an explicit `s3` client (tests) or
 * let the handler construct one against `AWS_REGION`.
 */
export async function handler(input: ArchiveInput): Promise<ArchiveResult> {
  const s3 =
    input.s3 ??
    new S3Client({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  const bucket = getBucket(input);
  const kmsKeyId = getKmsKey(input);
  const prefix = normalizePrefix(input.s3Prefix);

  const archived: ArchiveResultRow[] = [];
  for (const wf of input.workflows) {
    const sha256 = sha256OfCanonical(wf);
    const s3_key = `${prefix}${wf.id}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3_key,
        Body: canonicalJson(wf),
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: kmsKeyId,
        Metadata: {
          'kos-sha256': sha256,
          'kos-archived-by': 'n8n-workflow-archiver',
        },
      }),
    );
    archived.push({ workflow_id: wf.id, sha256, s3_key });
  }

  return { archived };
}
