import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-transcribe', () => ({
  TranscribeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  StartTranscriptionJobCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

const makeEvent = (): unknown => ({
  source: 'kos.capture',
  'detail-type': 'capture.received',
  detail: {
    capture_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
    channel: 'telegram',
    kind: 'voice',
    raw_ref: {
      s3_bucket: 'kos-blobs',
      s3_key: 'audio/2026/04/01HABCDEFGHJKMNPQRSTVWXYZ0.oga',
      duration_sec: 8,
      mime_type: 'audio/ogg',
    },
    sender: { id: 111, display: 'Kevin' },
    received_at: new Date().toISOString(),
    telegram: { chat_id: 111, message_id: 1 },
  },
});

describe('transcribe-starter', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({});
  });

  it('starts a Transcribe job with sv-SE + kos-sv-se-v1 vocab', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>)(
      makeEvent(),
      {},
      () => {
        /* noop */
      },
    );
    const firstCall = mockSend.mock.calls[0];
    if (!firstCall) throw new Error('mockSend was not called');
    const call = firstCall[0] as {
      input: {
        TranscriptionJobName: string;
        LanguageCode: string;
        Settings: { VocabularyName: string };
        MediaFormat: string;
        OutputKey: string;
      };
    };
    expect(call.input.TranscriptionJobName).toMatch(/^kos-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(call.input.LanguageCode).toBe('sv-SE');
    expect(call.input.Settings.VocabularyName).toBe('kos-sv-se-v1');
    expect(call.input.MediaFormat).toBe('ogg');
    expect(call.input.OutputKey).toBe('transcripts/01HABCDEFGHJKMNPQRSTVWXYZ0.json');
  });

  it('is idempotent on ConflictException', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { name: 'ConflictException' }),
    );
    const { handler } = await import('../src/handler.js');
    const res = (await (handler as unknown as (
      e: unknown,
      c?: unknown,
      cb?: unknown,
    ) => Promise<unknown>)(makeEvent(), {}, () => {
      /* noop */
    })) as { idempotentHit?: boolean };
    expect(res.idempotentHit).toBe(true);
  });
});
