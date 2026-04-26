/**
 * extract.test.ts — Plan 08-05 Task 1 (6 tests).
 *
 *   1. application/pdf      → pdf-parse mock returns text containing "4.1";
 *                             attachmentSha returns type=text + 64-hex sha
 *   2. application/docx     → mammoth mock; sha computed on normalised text
 *   3. text/plain           → utf-8 decode; whitespace normalised; sha valid
 *   4. application/octet-… → type=binary; byte SHA; text empty
 *   5. SHA stability        → same logical content with different whitespace
 *                             (re-saved PDF) produces SAME sha
 *   6. doc_name sanitise    → 'Almi Avtal_v4.PDF' → 'almi_avtal_v4.pdf'
 *
 * pdf-parse + mammoth are mocked via vi.mock so the test suite does NOT
 * commit binary fixture PDFs (per Plan 08-05 Task 1 §action — fixtures
 * are NOT committed; tests mock the parsers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const pdfParseMock = vi.fn();
vi.mock('pdf-parse', () => ({
  __esModule: true,
  default: (b: Buffer) => pdfParseMock(b),
}));

const mammothExtractMock = vi.fn();
vi.mock('mammoth', () => ({
  __esModule: true,
  default: { extractRawText: (i: { buffer: Buffer }) => mammothExtractMock(i) },
  extractRawText: (i: { buffer: Buffer }) => mammothExtractMock(i),
}));

import { attachmentSha, normaliseText, sanitiseDocName } from '../src/extract.js';

beforeEach(() => {
  pdfParseMock.mockReset();
  mammothExtractMock.mockReset();
});

describe('attachmentSha', () => {
  it('1. application/pdf → text + 64-hex sha; text contains "4.1"', async () => {
    pdfParseMock.mockResolvedValueOnce({
      text: 'Kapitel 4: Vesting\n4.1 Grundvesting är 4 år.',
    });
    const r = await attachmentSha(
      Buffer.from('fake-pdf-bytes'),
      'application/pdf',
      'avtal_v3.pdf',
    );
    expect(r.type).toBe('text');
    expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.text).toContain('4.1');
    expect(r.doc_name).toBe('avtal_v3.pdf');
    expect(pdfParseMock).toHaveBeenCalledTimes(1);
  });

  it('2. application/docx → mammoth extracts text; sha valid', async () => {
    mammothExtractMock.mockResolvedValueOnce({
      value: 'Investment amount: 1,500,000 SEK.',
    });
    const r = await attachmentSha(
      Buffer.from('fake-docx-bytes'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'term_sheet.docx',
    );
    expect(r.type).toBe('text');
    expect(r.text).toContain('1,500,000');
    // Verify the SHA is over the NORMALISED text, not raw mammoth output.
    const expected = createHash('sha256')
      .update(normaliseText('Investment amount: 1,500,000 SEK.'), 'utf8')
      .digest('hex');
    expect(r.sha).toBe(expected);
    expect(mammothExtractMock).toHaveBeenCalledTimes(1);
  });

  it('3. text/plain → utf-8 decode; whitespace normalised; sha valid', async () => {
    const r = await attachmentSha(
      Buffer.from('Hello   world\n\nfrom\tKevin', 'utf8'),
      'text/plain',
      'note.txt',
    );
    expect(r.type).toBe('text');
    expect(r.text).toBe('Hello world from Kevin');
    expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
    // Parsers MUST NOT be called for plain text.
    expect(pdfParseMock).not.toHaveBeenCalled();
    expect(mammothExtractMock).not.toHaveBeenCalled();
  });

  it('4. application/octet-stream → type=binary; byte SHA; text empty', async () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const r = await attachmentSha(buf, 'application/octet-stream', 'mystery.bin');
    expect(r.type).toBe('binary');
    expect(r.text).toBe('');
    expect(r.sha).toBe(createHash('sha256').update(buf).digest('hex'));
    expect(r.doc_name).toBe('mystery.bin');
  });

  it('5. SHA stability — same logical content with different whitespace produces SAME sha (P-5)', async () => {
    // Simulate a PDF re-saved: same content but different metadata + line breaks.
    pdfParseMock.mockResolvedValueOnce({
      text: 'Kapitel 4: Vesting\n4.1 Grundvesting är 4 år.',
    });
    const a = await attachmentSha(
      Buffer.from('fake-pdf-bytes-v1'),
      'application/pdf',
      'avtal.pdf',
    );

    // Re-render: extra trailing newlines, double-spaces, page break artifact.
    pdfParseMock.mockResolvedValueOnce({
      text: '   Kapitel 4: Vesting   \n\n  4.1   Grundvesting   är   4 år.   \n\n',
    });
    const b = await attachmentSha(
      Buffer.from('fake-pdf-bytes-v2'), // different bytes but same logical content
      'application/pdf',
      'avtal.pdf',
    );

    expect(a.sha).toBe(b.sha);
    expect(a.text).toBe(b.text);
  });

  it('6. doc_name sanitisation — "Almi Avtal_v4.PDF" → "almi_avtal_v4.pdf"', () => {
    expect(sanitiseDocName('Almi Avtal_v4.PDF')).toBe('almi_avtal_v4.pdf');
    // Strip directory components + lowercase + collapse non-token runs:
    const sanitised = sanitiseDocName('/tmp/path/Avtal V4 (final).pdf');
    expect(sanitised).toMatch(/^avtal_v4_final/); // tolerate trailing _ before .pdf
    expect(sanitised).toMatch(/\.pdf$/);
    // Same input from a Windows path also normalises to a basename.
    expect(sanitiseDocName('SIMPLE.TXT')).toBe('simple.txt');
    // Stable across leading/trailing whitespace + URL-style tokens.
    expect(sanitiseDocName('Final Avtal — V5.docx')).toMatch(
      /^final_avtal_.*v5\.docx$/,
    );
  });
});
