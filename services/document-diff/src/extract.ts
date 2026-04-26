/**
 * @kos/service-document-diff — attachmentSha (Plan 08-05 Task 1).
 *
 * Single responsibility: extract text from a binary attachment buffer,
 * normalise whitespace, and return a SHA-256 of the NORMALISED TEXT
 * (NOT raw bytes). Trivial re-saves of the same PDF with different
 * metadata produce the SAME sha — exactly what MEM-05 wants so a doc
 * forwarded twice in error doesn't appear as two distinct versions.
 *
 * Three text branches:
 *   - application/pdf                                    → pdf-parse
 *   - application/vnd.openxmlformats-officedocument...   → mammoth
 *   - text/* + text/markdown + application/x-markdown    → utf-8 decode
 *
 * Binary fallback: any other mime type produces a BYTE sha + empty text +
 * type='binary'. The handler maps type='binary' to a fixed diff_summary
 * "binary — SHA only" so version chaining still works (SHA-on-bytes is
 * stable per file content) but no Haiku call is attempted.
 *
 * Filename sanitisation:
 *   - strip directory components
 *   - lowercase
 *   - replace any run of [^a-z0-9._-] with a single underscore
 *   - collapse runs of underscores
 * "Almi Avtal_v4.PDF" → "almi_avtal_v4.pdf".
 *
 * Whitespace normalisation per RESEARCH §P-5: replace /\s+/g with " " and
 * trim. This is the single byte-stable transformation between extracted
 * text and the SHA input. It catches:
 *   - Word docs re-saved with different line-ending conventions
 *   - PDF re-renders that move pagination but preserve content
 *   - Trailing whitespace introduced by mail clients
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface ExtractedAttachment {
  /** SHA-256 hex (64 chars) — of normalised text for text/*; of raw bytes for binary. */
  sha: string;
  /** Normalised text. Empty string for binary. */
  text: string;
  /** 'text' when extraction succeeded; 'binary' when mime was unsupported. */
  type: 'text' | 'binary';
  /** Sanitised filename — basename, lowercased, run-replaced. */
  doc_name: string;
}

/**
 * Sanitise a filename to a stable doc_name token. Non [a-z0-9._-] runs
 * collapse to a single underscore so "Avtal V4 (final).pdf" →
 * "avtal_v4_final.pdf" — both sides of the comparison normalise the
 * same way.
 */
export function sanitiseDocName(filename: string): string {
  const base = path.basename(String(filename ?? '')).toLowerCase();
  return base.replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_');
}

/**
 * Whitespace normalisation per RESEARCH §P-5. Public so tests can assert
 * the same transformation the handler uses.
 */
export function normaliseText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function shaText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function shaBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Extract text + sha from an attachment buffer. See module docstring for
 * the full per-mime branch table. Returns `type: 'binary'` for any mime
 * type that can't be parsed; the caller sets `diff_summary` to the
 * fixed string "binary — SHA only" in that case.
 *
 * Throws ONLY when the underlying parser (pdf-parse / mammoth) errors —
 * the handler should catch and either fall back to byte-SHA or surface
 * to dead-letter. Empty buffers + zero-byte attachments produce text=""
 * and the corresponding empty-text SHA.
 */
export async function attachmentSha(
  buf: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractedAttachment> {
  const docName = sanitiseDocName(filename);
  const mt = (mimeType ?? '').toLowerCase();

  if (mt === PDF_MIME) {
    // Dynamic import — pdf-parse pulls in its own debug-mode test fixture
    // at top-of-file load time which fails when bundled by esbuild. Lazy
    // import sidesteps that (matches the upstream README's recommended
    // usage pattern).
    type PdfParseFn = (b: Buffer) => Promise<{ text: string }>;
    const mod = (await import('pdf-parse')) as unknown as
      | PdfParseFn
      | { default?: PdfParseFn; pdf?: PdfParseFn };
    let parser: PdfParseFn | undefined;
    if (typeof mod === 'function') {
      parser = mod;
    } else {
      parser = mod.default ?? mod.pdf;
    }
    if (typeof parser !== 'function') {
      throw new Error('pdf-parse export shape unrecognised');
    }
    const parsed = await parser(buf);
    const text = normaliseText(parsed.text ?? '');
    return { sha: shaText(text), text, type: 'text', doc_name: docName };
  }

  if (mt === DOCX_MIME) {
    const mod = (await import('mammoth')) as unknown as {
      default?: { extractRawText: (i: { buffer: Buffer }) => Promise<{ value: string }> };
      extractRawText?: (i: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const extract =
      mod.extractRawText ??
      (mod.default ? mod.default.extractRawText : undefined);
    if (typeof extract !== 'function') {
      throw new Error('mammoth export shape unrecognised');
    }
    const r = await extract({ buffer: buf });
    const text = normaliseText(r.value ?? '');
    return { sha: shaText(text), text, type: 'text', doc_name: docName };
  }

  if (
    mt.startsWith('text/') ||
    mt === 'application/x-markdown' ||
    mt === 'application/markdown'
  ) {
    const text = normaliseText(buf.toString('utf8'));
    return { sha: shaText(text), text, type: 'text', doc_name: docName };
  }

  // Binary fallback — byte-SHA, empty text, type='binary'.
  return {
    sha: shaBytes(buf),
    text: '',
    type: 'binary',
    doc_name: docName,
  };
}
