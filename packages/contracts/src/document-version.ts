/**
 * Phase 8 / Plan 08-00 — Document version tracking schemas (MEM-05).
 *
 * Two exported Zod schemas:
 *   - DocumentVersionSchema         — document_versions row shape
 *   - DocumentVersionCreatedSchema  — emitted on kos.output by document-diff
 *
 * Versioning is content-addressed by sha256. Successive copies of the same
 * document attached to different emails (e.g. avtal_v3.pdf, avtal_v4.pdf
 * with different bytes) produce distinct rows; identical bytes (rev sent
 * twice in error) produce zero new rows via the (recipient_email, doc_name,
 * sha256) UNIQUE constraint.
 */
import { z } from 'zod';

const UlidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// --- document_versions row ---------------------------------------------
//
// `recipient_email` is the canonical identifier for "who is this document
// for" — Kevin's reasoning is "the same doc to the same person across
// versions". `doc_name` is the filename minus version markers when
// detectable (avtal_v3.pdf → avtal.pdf); when not detectable, the raw name
// is kept and the diff is computed against any prior matching name.
//
// `sha256` is the hash of the extracted text (NOT the raw bytes), so
// trivial re-saves with different metadata don't produce phantom versions.
// `parent_sha256` is null only for v1 of a doc; subsequent versions carry
// the previous version's hash for chain reconstruction.
export const DocumentVersionSchema = z.object({
  id: z.string().uuid(),
  recipient_email: z.string(),
  doc_name: z.string(),
  sha256: z.string().length(64),
  s3_bucket: z.string(),
  s3_key: z.string(),
  version_n: z.number().int().min(1),
  parent_sha256: z.string().length(64).nullable(),
  diff_summary: z.string().nullable(),
  sent_at: z.string().datetime(),
  capture_id: z.string().regex(UlidRegex),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

// --- document.version_created (kos.output) -----------------------------
//
// Lightweight emit consumed by the dashboard SSE — surfaces "v4 of avtal.pdf
// to christina@almi.se: 4.2 ESOP clause added" in the inbox card. Does NOT
// carry the full text or the s3_ref, just the metadata + diff summary.
export const DocumentVersionCreatedSchema = z.object({
  capture_id: z.string().regex(UlidRegex),
  recipient_email: z.string(),
  doc_name: z.string(),
  version_n: z.number().int().min(1),
  sha256: z.string().length(64),
  diff_summary: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type DocumentVersionCreated = z.infer<typeof DocumentVersionCreatedSchema>;
