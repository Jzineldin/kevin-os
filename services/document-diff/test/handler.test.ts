/**
 * handler.test.ts — Plan 08-05 Task 1 (7 tests).
 *
 *   1. email.sent w/ attachments[] + no prior → v1 inserted with parent_sha=null
 *   2. email.sent w/ attachments[] same recipient/doc, DIFFERENT sha → v2 with
 *      parent_sha + diff_summary from Haiku
 *   3. email.sent same recipient/doc, SAME sha → no new version inserted
 *      (skipped: 'unchanged')
 *   4. email.sent with NO attachments → skipped: 'no_attachments'
 *   5. Multiple recipients → one document_versions row PER recipient
 *   6. Binary attachment → inserted with type=binary + diff_summary='binary — SHA only'
 *   7. document.version.created emitted per new version
 *
 * The handler is invoked with a synthesised email.sent EventBridge event
 * and a mocked S3 client + mocked pg pool + mocked EventBridge client.
 * pdf-parse / mammoth are not exercised — text/plain attachments are
 * used everywhere so the extract path is deterministic without binary
 * fixtures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------
// Module mocks — installed BEFORE the handler is imported.
// ---------------------------------------------------------------------

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  Sentry: {},
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const ebSendMock = vi.fn(async () => ({}));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class MockEB {
    send = ebSendMock;
  },
  PutEventsCommand: class MockCmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const s3SendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3 {
    send = s3SendMock;
  },
  GetObjectCommand: class MockCmd {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const generateDiffSummaryMock = vi.fn();
vi.mock('../src/diff-summary.js', () => ({
  generateDiffSummary: (...a: unknown[]) => generateDiffSummaryMock(...a),
}));

vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class MockSigner {
    async getAuthToken() {
      return 'fake-token';
    }
  },
}));
vi.mock('pg', () => {
  class MockPool {
    constructor() {
      // no-op
    }
    query = vi.fn();
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function s3BodyFromText(text: string) {
  return { Body: Readable.from([Buffer.from(text, 'utf8')]) };
}

function shaOfNormalised(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

const ownerId = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const captureId = '01HK000000000000000000000A';

function makeEvent(detail: Record<string, unknown>) {
  return {
    source: 'kos.output',
    'detail-type': 'email.sent',
    detail: { capture_id: captureId, sent_at: '2026-04-25T12:00:00.000Z', ...detail },
  };
}

interface InvokeResult {
  created?: Array<{
    recipient: string;
    doc_name: string;
    version_n: number;
    sha: string;
    version_id: string;
  }>;
  unchanged?: Array<{ recipient: string; doc_name: string; sha: string }>;
  skipped?: string;
}

/**
 * Sentry's wrapHandler types the wrapped function as a Lambda 3-arg
 * signature. Pass empty context + noop callback (mirrors
 * services/email-sender/test/handler.test.ts).
 */
async function invoke(
  handler: unknown,
  event: unknown,
): Promise<InvokeResult> {
  const fn = handler as (
    e: unknown,
    c: unknown,
    cb: (err: unknown, r?: unknown) => void,
  ) => Promise<unknown>;
  const r = await fn(event, {}, () => {});
  return (r ?? {}) as InvokeResult;
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(): MockPool {
  return { query: vi.fn() };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

beforeEach(() => {
  ebSendMock.mockClear();
  s3SendMock.mockReset();
  generateDiffSummaryMock.mockReset();
  process.env.KEVIN_OWNER_ID = ownerId;
  process.env.AWS_REGION = 'eu-north-1';
  process.env.RDS_PROXY_ENDPOINT = 'kos-rds-proxy.example.local';
});

describe('document-diff handler', () => {
  it('1. email.sent + attachments + no prior → v1 inserted with parent_sha=null', async () => {
    const text = 'Hello version one';
    s3SendMock.mockResolvedValueOnce(s3BodyFromText(text));

    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
    });

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    const r = await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'note.txt',
            mime_type: 'text/plain',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/abc.txt',
            size_bytes: 18,
          },
        ],
        to_emails: ['damien@almi.se'],
      }),
    );

    expect(r).toMatchObject({
      created: [
        expect.objectContaining({
          recipient: 'damien@almi.se',
          doc_name: 'note.txt',
          version_n: 1,
        }),
      ],
    });

    const insertCall = pool.query.mock.calls[1]!;
    expect(insertCall[0]).toMatch(/INSERT INTO document_versions/);
    const params = insertCall[1] as unknown[];
    expect(params[6]).toBe(1); // version_n = 1
    expect(params[7]).toBeNull(); // parent_sha256 = null
    expect(params[8]).toBeNull(); // diff_summary = null (no prior)
    expect(params[3]).toBe(shaOfNormalised(text)); // sha256
  });

  it('2. same recipient/doc, DIFFERENT sha → v2 with parent_sha + Haiku diff_summary', async () => {
    const newText = 'Hello version two with new clause';
    const priorSha = shaOfNormalised('Hello version one');
    s3SendMock.mockResolvedValueOnce(s3BodyFromText(newText));

    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'prior-id',
          sha256: priorSha,
          version_n: 1,
          parent_sha256: null,
          doc_name: 'note.txt',
          s3_bucket: 'kos-blobs',
          s3_key: 'old.txt',
        },
      ],
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
    });

    generateDiffSummaryMock.mockResolvedValueOnce(
      'Added "new clause" wording in the current version.',
    );

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    const r = await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'note.txt',
            mime_type: 'text/plain',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/v2.txt',
            size_bytes: 32,
          },
        ],
        to_emails: ['damien@almi.se'],
      }),
    );

    expect(r.created).toHaveLength(1);
    expect(r.created![0]).toMatchObject({ version_n: 2 });

    expect(generateDiffSummaryMock).toHaveBeenCalledTimes(1);
    const insertParams = pool.query.mock.calls[1]![1] as unknown[];
    expect(insertParams[6]).toBe(2);
    expect(insertParams[7]).toBe(priorSha);
    expect(insertParams[8]).toContain('new clause');
  });

  it('3. same SHA → no new version inserted; unchanged returned', async () => {
    const text = 'Hello version one';
    const sha = shaOfNormalised(text);
    s3SendMock.mockResolvedValueOnce(s3BodyFromText(text));

    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'prior-id',
          sha256: sha,
          version_n: 1,
          parent_sha256: null,
          doc_name: 'note.txt',
          s3_bucket: 'kos-blobs',
          s3_key: 'old.txt',
        },
      ],
    });

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    const r = await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'note.txt',
            mime_type: 'text/plain',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/dup.txt',
            size_bytes: 18,
          },
        ],
        to_emails: ['damien@almi.se'],
      }),
    );

    expect(r.created ?? []).toHaveLength(0);
    expect(r.unchanged).toEqual([
      { recipient: 'damien@almi.se', doc_name: 'note.txt', sha },
    ]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(generateDiffSummaryMock).not.toHaveBeenCalled();
  });

  it('4. email.sent with NO attachments → skipped: no_attachments', async () => {
    const { handler } = await import('../src/handler.js');
    const r = await invoke(
      handler,
      makeEvent({ attachments: [], to_emails: ['damien@almi.se'] }),
    );
    expect(r).toEqual({ skipped: 'no_attachments' });
  });

  it('5. Multiple recipients → one document_versions row PER recipient', async () => {
    const text = 'Multi recipient note';
    s3SendMock.mockResolvedValueOnce(s3BodyFromText(text));

    const pool = makePool();
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'rec1-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'rec2-id' }] });

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    const r = await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'multi.txt',
            mime_type: 'text/plain',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/multi.txt',
            size_bytes: 20,
          },
        ],
        to_emails: ['damien@almi.se', 'christina@almi.se'],
      }),
    );

    expect(r.created).toHaveLength(2);
    const recipients = r.created!.map((c) => c.recipient).sort();
    expect(recipients).toEqual(['christina@almi.se', 'damien@almi.se']);
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it('6. Binary attachment → diff_summary "binary — SHA only" (when prior exists)', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x42, 0x10, 0x99]);
    s3SendMock.mockResolvedValueOnce({ Body: Readable.from([bytes]) });

    const pool = makePool();
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'prior-id',
          sha256: 'previous-sha-different',
          version_n: 1,
          parent_sha256: null,
          doc_name: 'mystery.bin',
          s3_bucket: 'kos-blobs',
          s3_key: 'old.bin',
        },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'bin-id' }] });

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    const r = await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'mystery.bin',
            mime_type: 'application/octet-stream',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/mystery.bin',
            size_bytes: 5,
          },
        ],
        to_emails: ['damien@almi.se'],
      }),
    );

    expect(r.created).toHaveLength(1);
    expect(r.created![0]!.version_n).toBe(2);
    const insertParams = pool.query.mock.calls[1]![1] as unknown[];
    expect(insertParams[8]).toBe('binary — SHA only');
    expect(generateDiffSummaryMock).not.toHaveBeenCalled();
  });

  it('7. emits document.version.created event per new version', async () => {
    const text = 'fresh content';
    s3SendMock.mockResolvedValueOnce(s3BodyFromText(text));

    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'new-id' }] });

    const { handler, __setS3ClientForTest, __setEventBridgeClientForTest } = await import(
      '../src/handler.js'
    );
    const { __setPoolForTest } = await import('../src/persist.js');
    __setPoolForTest(pool as never);
    __setS3ClientForTest(null);
    __setEventBridgeClientForTest(null);

    await invoke(
      handler,
      makeEvent({
        attachments: [
          {
            filename: 'fresh.txt',
            mime_type: 'text/plain',
            s3_bucket: 'kos-blobs',
            s3_key: 'attachments/fresh.txt',
            size_bytes: text.length,
          },
        ],
        to_emails: ['damien@almi.se'],
      }),
    );

    expect(ebSendMock).toHaveBeenCalledTimes(1);
    const ebCall = (ebSendMock.mock.calls as unknown as Array<Array<unknown>>)[0]![0] as {
      input: { Entries: Array<{ DetailType: string; Source: string; Detail: string }> };
    };
    expect(ebCall.input.Entries[0]!.DetailType).toBe('document.version.created');
    expect(ebCall.input.Entries[0]!.Source).toBe('kos.output');
    const detail = JSON.parse(ebCall.input.Entries[0]!.Detail) as {
      recipient_email: string;
      doc_name: string;
      version_n: number;
      sha256: string;
    };
    expect(detail.recipient_email).toBe('damien@almi.se');
    expect(detail.doc_name).toBe('fresh.txt');
    expect(detail.version_n).toBe(1);
    expect(detail.sha256).toBe(shaOfNormalised(text));
  });
});
