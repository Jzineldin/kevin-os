/**
 * @kos/service-document-diff — Phase 8 MEM-05 per-document version
 * tracker.
 *
 * Lambda subscribes to `kos.output / email.sent` (CDK rule wired in
 * Plan 08-05 Task 2). For each attachment in the event detail:
 *   1. Pull the raw bytes from S3 (kos-blobs bucket)
 *   2. Extract text + compute SHA-256 (extract.attachmentSha)
 *   3. For each recipient_email in the event:
 *      a. Load the most recent prior version for (recipient, doc_name)
 *      b. If prior.sha256 == new.sha → skip (idempotent, no new row)
 *      c. Else compute diff_summary via Haiku 4.5 (or the fixed
 *         "binary — SHA only" string for binary attachments)
 *      d. INSERT a new document_versions row with version_n = prior+1
 *         and parent_sha256 = prior.sha256
 *      e. Emit `document.version.created` on kos.output for the
 *         dashboard SSE
 *
 * Structural separation:
 *   - NO ses:* / postiz:* / notion writes IAM grants (CDK enforces).
 *   - bedrock:InvokeModel scoped to Haiku 4.5 EU profile only — Sonnet
 *     and other models would 403.
 *   - rds-db:connect as `kos_document_diff` ONLY (read+insert on
 *     document_versions; no UPDATE, no DELETE).
 *
 * Idempotency:
 *   - Pre-check via loadPriorVersion + SHA equality: same (recipient,
 *     doc_name, sha) seen twice → skip on the second invocation.
 *   - DB-level UNIQUE constraint on (recipient_email, doc_name, sha256)
 *     catches the concurrent-replay race (two Lambdas firing on the
 *     same email.sent event) — insertDocumentVersion returns null and
 *     the handler treats that as a no-op.
 *
 * Timing budget (CONTEXT D-29): p95 < 10 s per attachment.
 *   - S3 GetObject:  ~150 ms cold, ~50 ms warm (eu-north-1)
 *   - pdf-parse 50p: ~3-5 s
 *   - Haiku 4.5:     ~1-2 s for 2x2000-char input
 *   - INSERT:        ~30 ms via RDS Proxy
 *   Total typical:   3-7 s. The Lambda timeout is 2 minutes (CDK).
 *
 * Spec: .planning/phases/08-outbound-content-calendar/08-05-PLAN.md
 * Migration: 0020 — document_versions table.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { DocumentVersionCreatedSchema } from '@kos/contracts';
import { attachmentSha, type ExtractedAttachment } from './extract.js';
import { generateDiffSummary } from './diff-summary.js';
import {
  getPool,
  loadPriorVersion,
  insertDocumentVersion,
  type QueryablePool,
} from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

let s3Client: S3Client | null = null;
let ebClient: EventBridgeClient | null = null;

function getS3(): S3Client {
  if (s3Client) return s3Client;
  s3Client = new S3Client({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return s3Client;
}

function getEventBridge(): EventBridgeClient {
  if (ebClient) return ebClient;
  ebClient = new EventBridgeClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return ebClient;
}

/** Test seams — vitest swaps in mocks. */
export function __setS3ClientForTest(fake: S3Client | null): void {
  s3Client = fake;
}
export function __setEventBridgeClientForTest(
  fake: EventBridgeClient | null,
): void {
  ebClient = fake;
}

/** Read the entire S3 object body into a Buffer. */
async function s3ToBuffer(bucket: string, key: string): Promise<Buffer> {
  const r = await getS3().send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  // Body is a Readable on Node runtime. Using async iteration for chunks.
  const body = r.Body as unknown as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const c of body) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

interface AttachmentMetadata {
  filename: string;
  mime_type: string;
  s3_bucket: string;
  s3_key: string;
  size_bytes?: number;
}

interface EmailSentDetail {
  capture_id: string;
  draft_id?: string;
  ses_message_id?: string;
  sent_at: string;
  attachments?: AttachmentMetadata[];
  to_emails?: string[];
}

interface EBEvent {
  source?: string;
  'detail-type'?: string;
  detail?: unknown;
  time?: string;
}

interface CreatedEntry {
  recipient: string;
  doc_name: string;
  version_n: number;
  sha: string;
  version_id: string;
}

interface UnchangedEntry {
  recipient: string;
  doc_name: string;
  sha: string;
}

export interface DocumentDiffResult {
  created?: CreatedEntry[];
  unchanged?: UnchangedEntry[];
  skipped?: string;
}

const BINARY_DIFF_SUMMARY = 'binary — SHA only';

/**
 * Compute the diff_summary for a (prior, current) pair. Branches:
 *   - prior is null  → null (v1 has no diff)
 *   - type=binary    → fixed string "binary — SHA only"
 *   - text + Haiku   → call generateDiffSummary; fall back to a tagged
 *                      placeholder if Haiku errors so we still record
 *                      the version (the SHA chain is the source of truth)
 */
async function computeDiffSummary(args: {
  prior: { sha256: string } | null;
  ext: ExtractedAttachment;
  recipient: string;
  // Optional: the prior version's extracted text. v1 doesn't cache text
  // on document_versions (see CAVEATS in 08-05-PLAN.md), so this is
  // null — Haiku gets only the current text + the SHA fact and is told
  // to summarise structurally.
  priorText: string | null;
}): Promise<string | null> {
  if (args.prior === null) return null;
  if (args.ext.type === 'binary') return BINARY_DIFF_SUMMARY;
  try {
    return await generateDiffSummary({
      priorText: args.priorText ?? '',
      currentText: args.ext.text,
      docName: args.ext.doc_name,
      recipient: args.recipient,
    });
  } catch (err) {
    return `[diff_summary generation failed: ${String(err).slice(0, 200)}]`;
  }
}

export const handler = wrapHandler(
  async (event: EBEvent): Promise<DocumentDiffResult> => {
    await initSentry();
    await setupOtelTracingAsync();

    const ownerId = process.env.KEVIN_OWNER_ID;
    if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

    try {
      if (event['detail-type'] !== 'email.sent') {
        return { skipped: `detail-type:${event['detail-type'] ?? 'undefined'}` };
      }
      const detail = (event.detail ?? {}) as EmailSentDetail;
      const captureId = detail.capture_id;
      if (typeof captureId === 'string' && captureId.length > 0) {
        tagTraceWithCaptureId(captureId);
      }

      const attachments = Array.isArray(detail.attachments)
        ? detail.attachments
        : [];
      const recipients = Array.isArray(detail.to_emails)
        ? detail.to_emails
        : [];
      if (attachments.length === 0) return { skipped: 'no_attachments' };
      if (recipients.length === 0) return { skipped: 'no_recipients' };

      const pool = (await getPool()) as unknown as QueryablePool;
      const created: CreatedEntry[] = [];
      const unchanged: UnchangedEntry[] = [];

      for (const att of attachments) {
        const buf = await s3ToBuffer(att.s3_bucket, att.s3_key);
        const ext = await attachmentSha(buf, att.mime_type, att.filename);

        for (const recipient of recipients) {
          const prior = await loadPriorVersion(pool, {
            recipientEmail: recipient,
            docName: ext.doc_name,
            ownerId,
          });

          if (prior && prior.sha256 === ext.sha) {
            unchanged.push({
              recipient,
              doc_name: ext.doc_name,
              sha: ext.sha,
            });
            continue;
          }

          const diffSummary = await computeDiffSummary({
            prior,
            ext,
            recipient,
            // v1: priorText is not cached on document_versions. Haiku
            // gets the current text + null prior and produces a
            // best-effort summary based on the current content alone.
            // v1.1 adds a text_extract column + back-fills (SUMMARY).
            priorText: null,
          });

          const versionN = (prior?.version_n ?? 0) + 1;
          const parentSha = prior?.sha256 ?? null;

          const inserted = await insertDocumentVersion(pool, {
            ownerId,
            recipientEmail: recipient,
            docName: ext.doc_name,
            sha: ext.sha,
            s3Bucket: att.s3_bucket,
            s3Key: att.s3_key,
            parentSha,
            versionN,
            diffSummary,
            sentAt: detail.sent_at,
            captureId,
          });

          if (inserted === null) {
            // ON CONFLICT — another invocation already wrote this exact
            // (recipient, doc, sha). Treat as unchanged so the dashboard
            // sees one consistent set of rows.
            unchanged.push({
              recipient,
              doc_name: ext.doc_name,
              sha: ext.sha,
            });
            continue;
          }

          // Emit document.version.created for the dashboard SSE. Validated
          // through Zod so a schema regression here surfaces as a Lambda
          // error rather than a malformed event on the bus.
          const eventDetail = DocumentVersionCreatedSchema.parse({
            capture_id: captureId,
            recipient_email: recipient,
            doc_name: ext.doc_name,
            version_n: versionN,
            sha256: ext.sha,
            diff_summary: diffSummary,
            created_at: new Date().toISOString(),
          });
          try {
            await getEventBridge().send(
              new PutEventsCommand({
                Entries: [
                  {
                    EventBusName: process.env.OUTPUT_BUS_NAME ?? 'kos.output',
                    Source: 'kos.output',
                    DetailType: 'document.version.created',
                    Detail: JSON.stringify(eventDetail),
                  },
                ],
              }),
            );
          } catch (emitErr) {
            // eslint-disable-next-line no-console
            console.warn(
              '[document-diff] document.version.created emit failed',
              emitErr,
            );
          }

          created.push({
            recipient,
            doc_name: ext.doc_name,
            version_n: versionN,
            sha: ext.sha,
            version_id: inserted.version_id,
          });
        }
      }

      return { created, unchanged };
    } finally {
      await langfuseFlush();
    }
  },
);
