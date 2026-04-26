/**
 * @kos/service-document-diff — RDS Proxy IAM-auth pool + the two queries
 * the handler issues against document_versions.
 *
 * Connection pattern mirrors services/email-sender/src/persist.ts:
 * `pg.Pool` with the password fn calling `@aws-sdk/rds-signer.getAuthToken`,
 * so each new connection mints a fresh 15-min IAM token automatically.
 *
 * Two operations:
 *
 *   loadPriorVersion(pool, { recipientEmail, docName, ownerId })
 *     SELECT id, sha256, version_n, parent_sha256, doc_name FROM document_versions
 *     WHERE owner_id=$1 AND recipient_email=$2 AND doc_name=$3
 *     ORDER BY version_n DESC LIMIT 1.
 *     Returns null when no prior version exists.
 *
 *   insertDocumentVersion(pool, args)
 *     INSERT INTO document_versions (...) VALUES (...) RETURNING id.
 *     ON CONFLICT DO NOTHING on the (recipient_email, doc_name, sha256)
 *     unique constraint — if two replays of the same email.sent event
 *     race, the second simply returns null and the handler treats it
 *     as a no-op skip.
 *
 * Idempotency is achieved by:
 *   1. The UNIQUE constraint on (recipient_email, doc_name, sha256).
 *   2. The handler's pre-check via loadPriorVersion that short-circuits
 *      when the same SHA already exists for the same (recipient, doc).
 * Both belt+braces — the constraint catches the rare race where two
 * Lambdas fire on a duplicate event in parallel.
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER ?? 'kos_document_diff';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const signer = new Signer({
    hostname: host,
    port: 5432,
    region,
    username: user,
  });
  pool = new Pool({
    host,
    port: 5432,
    user,
    database: process.env.RDS_DATABASE ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

/** Test seam — vitest injects a mock pool to skip real Postgres. */
export function __setPoolForTest(fake: PgPool | null): void {
  pool = fake;
}

/**
 * Minimal pg-compatible interface — narrow surface so unit tests can
 * pass a `{ query }` mock without dragging in pg.
 */
export interface QueryablePool {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface PriorVersionRow {
  id: string;
  sha256: string;
  version_n: number;
  parent_sha256: string | null;
  doc_name: string;
  s3_bucket: string;
  s3_key: string;
}

/**
 * Look up the most recent version for (owner, recipient, doc_name).
 * Returns null when no prior version exists (this becomes v1 on insert).
 *
 * The query uses the `document_versions_recipient_doc_idx` index
 * (recipient_email, doc_name, version_n DESC) → LIMIT 1 is a single
 * index seek + no sort.
 */
export async function loadPriorVersion(
  pool: QueryablePool,
  args: {
    recipientEmail: string;
    docName: string;
    ownerId: string;
  },
): Promise<PriorVersionRow | null> {
  const r = await pool.query(
    `SELECT id, sha256, version_n, parent_sha256, doc_name, s3_bucket, s3_key
       FROM document_versions
       WHERE owner_id = $1
         AND recipient_email = $2
         AND doc_name = $3
       ORDER BY version_n DESC
       LIMIT 1`,
    [args.ownerId, args.recipientEmail, args.docName],
  );
  if (!r.rows || r.rows.length === 0) return null;
  return r.rows[0] as PriorVersionRow;
}

export interface InsertDocumentVersionArgs {
  ownerId: string;
  recipientEmail: string;
  docName: string;
  sha: string;
  s3Bucket: string;
  s3Key: string;
  parentSha: string | null;
  versionN: number;
  diffSummary: string | null;
  sentAt: string;
  captureId: string;
}

/**
 * Insert a new document_versions row. Returns the inserted row's id when
 * the insert succeeded; returns null when the unique-constraint kicks in
 * (recipient_email, doc_name, sha256 already present) — this happens on
 * concurrent replays of the same email.sent event.
 *
 * The caller treats `null` as "another invocation already wrote this
 * exact version" and skips the post-insert event emit.
 */
export async function insertDocumentVersion(
  pool: QueryablePool,
  args: InsertDocumentVersionArgs,
): Promise<{ version_id: string } | null> {
  const r = await pool.query(
    `INSERT INTO document_versions
        (owner_id, recipient_email, doc_name, sha256,
         s3_bucket, s3_key, version_n, parent_sha256,
         diff_summary, sent_at, capture_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11)
       ON CONFLICT (recipient_email, doc_name, sha256) DO NOTHING
       RETURNING id`,
    [
      args.ownerId,
      args.recipientEmail,
      args.docName,
      args.sha,
      args.s3Bucket,
      args.s3Key,
      args.versionN,
      args.parentSha,
      args.diffSummary,
      args.sentAt,
      args.captureId,
    ],
  );
  if (!r.rows || r.rows.length === 0) return null;
  const row = r.rows[0] as { id: string };
  return { version_id: row.id };
}
