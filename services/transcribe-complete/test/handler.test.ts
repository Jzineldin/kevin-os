import { describe, it, expect, vi, beforeEach } from 'vitest';

const ebSend = vi.fn();
const s3Send = vi.fn();
const transcribeSend = vi.fn();

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));
vi.mock('@aws-sdk/client-transcribe', () => ({
  TranscribeClient: vi.fn().mockImplementation(() => ({ send: transcribeSend })),
  GetTranscriptionJobCommand: vi
    .fn()
    .mockImplementation((x: unknown) => ({ input: x })),
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

type AnyHandler = (e: unknown, c?: unknown, cb?: unknown) => Promise<unknown>;

const META_BODY = JSON.stringify({
  raw_ref: {
    s3_bucket: 'kos-blobs-test',
    s3_key: 'audio/2026/04/x.oga',
    duration_sec: 5,
    mime_type: 'audio/ogg',
  },
  sender: { id: 111, display: 'Kevin' },
  received_at: '2026-04-22T10:00:00.000Z',
  telegram: { chat_id: 111, message_id: 1 },
});

describe('transcribe-complete', () => {
  beforeEach(() => {
    ebSend.mockClear();
    ebSend.mockResolvedValue({});
    s3Send.mockClear();
    transcribeSend.mockClear();
    process.env.BLOBS_BUCKET = 'kos-blobs-test';
    vi.resetModules();
  });

  it('reads transcript, reads meta, publishes capture.voice.transcribed', async () => {
    transcribeSend.mockResolvedValue({
      TranscriptionJob: {
        Transcript: {
          TranscriptFileUri:
            's3://kos-blobs-test/transcripts/01HABCDEFGHJKMNPQRSTVWXYZ0.json',
        },
      },
    });
    s3Send
      .mockResolvedValueOnce({
        Body: {
          transformToString: async () =>
            JSON.stringify({
              results: { transcripts: [{ transcript: 'hej Damien' }] },
            }),
        },
      })
      .mockResolvedValueOnce({
        Body: { transformToString: async () => META_BODY },
      });

    const { handler } = await import('../src/handler.js');
    await (handler as unknown as AnyHandler)(
      {
        source: 'aws.transcribe',
        'detail-type': 'Transcribe Job State Change',
        detail: {
          TranscriptionJobName: 'kos-01HABCDEFGHJKMNPQRSTVWXYZ0',
          TranscriptionJobStatus: 'COMPLETED',
          LanguageCode: 'sv-SE',
        },
      },
      {},
      () => {
        /* noop */
      },
    );

    const putEventsCall = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('capture.voice.transcribed'),
    );
    expect(putEventsCall).toBeDefined();
    if (!putEventsCall) throw new Error('PutEvents call not found');
    const input = (
      putEventsCall[0] as { input: { Entries: { Detail: string }[] } }
    ).input;
    const detail = JSON.parse(input.Entries[0]!.Detail) as {
      text: string;
      capture_id: string;
      vocab_name: string;
    };
    expect(detail.text).toBe('hej Damien');
    expect(detail.capture_id).toBe('01HABCDEFGHJKMNPQRSTVWXYZ0');
    expect(detail.vocab_name).toBe('kos-sv-se-v1');
  });

  it('emits transcribe.failed on FAILED status', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as AnyHandler)(
      {
        source: 'aws.transcribe',
        'detail-type': 'Transcribe Job State Change',
        detail: {
          TranscriptionJobName: 'kos-01HABCDEFGHJKMNPQRSTVWXYZ0',
          TranscriptionJobStatus: 'FAILED',
          FailureReason: 'audio format',
        },
      },
      {},
      () => {
        /* noop */
      },
    );
    const failedCall = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('transcribe.failed'),
    );
    expect(failedCall).toBeDefined();
  });

  it('retries once on S3 NoSuchKey for the transcript (Pitfall 2)', async () => {
    transcribeSend.mockResolvedValue({
      TranscriptionJob: {
        Transcript: {
          TranscriptFileUri: 's3://kos-blobs-test/transcripts/k.json',
        },
      },
    });
    s3Send
      .mockRejectedValueOnce(
        Object.assign(new Error('not yet'), { name: 'NoSuchKey' }),
      )
      .mockResolvedValueOnce({
        Body: {
          transformToString: async () =>
            JSON.stringify({
              results: { transcripts: [{ transcript: 'second try' }] },
            }),
        },
      })
      .mockResolvedValueOnce({
        Body: { transformToString: async () => META_BODY },
      });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as AnyHandler)(
      {
        source: 'aws.transcribe',
        'detail-type': 'Transcribe Job State Change',
        detail: {
          TranscriptionJobName: 'kos-01HABCDEFGHJKMNPQRSTVWXYZ0',
          TranscriptionJobStatus: 'COMPLETED',
        },
      },
      {},
      () => {
        /* noop */
      },
    );
    const ok = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('capture.voice.transcribed'),
    );
    expect(ok).toBeDefined();
  });
});
