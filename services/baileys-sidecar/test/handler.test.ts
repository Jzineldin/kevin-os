/**
 * Phase 5 Plan 05-05 — baileys-sidecar handler tests.
 *
 * Mocks: EventBridge + Secrets Manager + S3 client + global fetch + Sentry/
 * tracing helpers. Each test pins Date.now() so the deterministic
 * capture_id check is stable.
 *
 * Coverage (10 cases — see Plan 05-05 §Task 1):
 *   1. text message → 200 + capture.received {kind: whatsapp_text}
 *   2. audio message → media fetch → S3 put → capture.received {kind: whatsapp_voice}
 *   3. missing X-BAILEYS-Secret → 401, no PutEvents
 *   4. wrong X-BAILEYS-Secret → 401 (constant-time), no PutEvents
 *   5. fromMe=true → 200 + skip (defence in depth)
 *   6. unknown event (presence.update) → 200 + skip
 *   7. body has neither text nor audio → 400 no_routable_messages
 *   8. group jid (`@g.us`) → is_group=true on emitted detail
 *   9. deterministic capture_id — same (chat_jid, message_key_id) → same id
 *  10. detail shapes pass CaptureReceivedWhatsappText/Voice schemas
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  baileysIncomingTextEnvelope,
  baileysIncomingVoiceEnvelope,
} from '@kos/test-fixtures';
import {
  CaptureReceivedWhatsappTextSchema,
  CaptureReceivedWhatsappVoiceSchema,
} from '@kos/contracts';

// --- AWS SDK mocks ----------------------------------------------------------

const ebSend = vi.fn().mockResolvedValue({});
const ebPutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: ebPutCtor,
}));

const s3Send = vi.fn().mockResolvedValue({});
const s3PutCtor = vi.fn().mockImplementation((x: unknown) => ({ input: x }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  PutObjectCommand: s3PutCtor,
}));

const TEST_SECRET = 'test-baileys-shared-secret';
const smSend = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: smSend })),
  GetSecretValueCommand: vi
    .fn()
    .mockImplementation((x: unknown) => ({ input: x })),
}));

// Sentry + tracing pass-throughs (avoid network).
const initSentrySpy = vi.fn(async () => {});
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: initSentrySpy,
  wrapHandler: <T>(h: T): T => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
const tagSpy = vi.fn();
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));
vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: <T>(h: T): T => h,
}));

// --- Helpers ---------------------------------------------------------------

const NOW = 1714028400; // 2026-04-25T07:00:00Z

interface FnUrlOpts {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
}

function fnUrlEvent(opts: FnUrlOpts): unknown {
  return {
    rawPath: '/',
    requestContext: {
      http: { method: opts.method ?? 'POST', sourceIp: '10.0.1.7' },
    },
    headers: opts.headers ?? {},
    body: opts.body,
    isBase64Encoded: false,
  };
}

type AnyHandler = (e: unknown) => Promise<unknown>;
interface Resp {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

interface PutEventsCall {
  input: {
    Entries: {
      EventBusName: string;
      Source: string;
      DetailType: string;
      Detail: string;
    }[];
  };
}

interface S3PutCall {
  input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    ContentType: string;
  };
}

// Audio bytes returned by the mocked /media/{id} fetch.
const FAKE_OPUS_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]); // "OggS\0"

beforeEach(async () => {
  process.env.AWS_REGION = 'eu-north-1';
  process.env.BAILEYS_WEBHOOK_SECRET_ARN =
    'arn:aws:secretsmanager:eu-north-1:123456789012:secret:kos/baileys-webhook-secret';
  process.env.BLOBS_BUCKET = 'kos-blobs-test';
  process.env.BAILEYS_MEDIA_BASE_URL = 'http://baileys.kos-internal.local:3025/media';

  ebSend.mockClear();
  ebPutCtor.mockClear();
  s3Send.mockClear();
  s3PutCtor.mockClear();
  smSend.mockReset();
  smSend.mockImplementation(async () => ({ SecretString: TEST_SECRET }));

  // Mock global fetch for the /media/{id} call.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => FAKE_OPUS_BYTES.buffer,
    })),
  );

  initSentrySpy.mockClear();
  tagSpy.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  vi.resetModules();
  const sec = await import('../src/secrets.js');
  sec.__resetSecretsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('baileys-sidecar handler', () => {
  // ------------------------------------------------------------------- 1
  it('text messages.upsert → 200 + capture.received{whatsapp_text}', async () => {
    const body = JSON.stringify(baileysIncomingTextEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const call = ebSend.mock.calls[0]![0] as PutEventsCall;
    const entry = call.input.Entries[0]!;
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.Source).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');

    const detail = JSON.parse(entry.Detail) as Record<string, unknown>;
    expect(detail.kind).toBe('whatsapp_text');
    expect(detail.channel).toBe('whatsapp');
    expect(detail.body).toBe('Hey Kevin, check this out');
    expect(detail.from_name).toBe('Damien');
    expect(detail.is_group).toBe(false);
    expect(detail.jid).toBe('46700000000@s.whatsapp.net');
    expect(detail.chat_jid).toBe('46700000000@s.whatsapp.net');
    expect(typeof detail.capture_id).toBe('string');
    // Verify the schema-side validator accepts it.
    expect(() => CaptureReceivedWhatsappTextSchema.parse(detail)).not.toThrow();
    expect(tagSpy).toHaveBeenCalledWith(detail.capture_id);

    // No S3 put for text.
    expect(s3Send).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 2
  it('audio messages.upsert → media fetch → S3 put → capture.received{whatsapp_voice}', async () => {
    const body = JSON.stringify(baileysIncomingVoiceEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);

    // Fetched the media endpoint with the same secret bidirectionally.
    const fetchMock = (
      globalThis as unknown as {
        fetch: { mock: { calls: [string, { headers: Record<string, string> }][] } };
      }
    ).fetch;
    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('http://baileys.kos-internal.local:3025/media/');
    expect(url).toContain(encodeURIComponent('3A0000000000000001'));
    expect(init.headers['X-BAILEYS-Secret']).toBe(TEST_SECRET);

    // S3 put fired exactly once with audio/YYYY/MM/{ULID}.ogg.
    expect(s3Send).toHaveBeenCalledTimes(1);
    const s3Call = s3Send.mock.calls[0]![0] as S3PutCall;
    expect(s3Call.input.Bucket).toBe('kos-blobs-test');
    expect(s3Call.input.Key).toMatch(
      /^audio\/\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.ogg$/,
    );
    expect(s3Call.input.ContentType).toBe('audio/ogg; codecs=opus');
    expect(Buffer.from(s3Call.input.Body).equals(Buffer.from(FAKE_OPUS_BYTES))).toBe(true);

    expect(ebSend).toHaveBeenCalledTimes(1);
    const ebCall = ebSend.mock.calls[0]![0] as PutEventsCall;
    const detail = JSON.parse(ebCall.input.Entries[0]!.Detail) as Record<
      string,
      unknown
    >;
    expect(detail.kind).toBe('whatsapp_voice');
    expect(detail.channel).toBe('whatsapp');
    const rawRef = detail.raw_ref as Record<string, unknown>;
    expect(rawRef.s3_bucket).toBe('kos-blobs-test');
    expect(rawRef.s3_key).toBe(s3Call.input.Key);
    expect(rawRef.duration_sec).toBe(17);
    expect(rawRef.mime_type).toBe('audio/ogg; codecs=opus');
    expect(detail.is_group).toBe(false);
    expect(() =>
      CaptureReceivedWhatsappVoiceSchema.parse(detail),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------- 3
  it('missing X-BAILEYS-Secret → 401, no PutEvents, no S3 put', async () => {
    const body = JSON.stringify(baileysIncomingTextEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ body, headers: {} }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('missing_secret');
    expect(ebSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 4
  it('wrong X-BAILEYS-Secret → 401 (constant-time compare), no PutEvents', async () => {
    const body = JSON.stringify(baileysIncomingTextEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': 'wrong-secret-value' },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
    expect(ebSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  // Length-equal but-different secret also fails (timingSafeEqual path).
  it('wrong X-BAILEYS-Secret of identical LENGTH → still 401', async () => {
    const body = JSON.stringify(baileysIncomingTextEnvelope);
    const same_length = 'a'.repeat(TEST_SECRET.length);
    expect(same_length.length).toBe(TEST_SECRET.length);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': same_length },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(401);
    expect(ebSend).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 5
  it('fromMe=true → 200 skip + no PutEvents (read-only defence in depth)', async () => {
    const fromMeEnvelope = {
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              remoteJid: '46700000000@s.whatsapp.net',
              fromMe: true,
              id: '3A0000000000000099',
            },
            messageTimestamp: NOW,
            pushName: 'Kevin',
            message: { conversation: 'I would never type this' },
          },
        ],
        type: 'notify',
      },
    };
    const body = JSON.stringify(fromMeEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    // Every message was unroutable (fromMe filtered) → no_routable_messages
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('no_routable_messages');
    expect(ebSend).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 6
  it('unknown event (presence.update) → 200 + skipped', async () => {
    const presenceEnvelope = {
      event: 'presence.update',
      data: { id: 'foo' },
    };
    const body = JSON.stringify(presenceEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const respBody = JSON.parse(res.body) as { status: string; reason: string };
    expect(respBody.status).toBe('skipped');
    expect(respBody.reason).toBe('not_messages_upsert');
    expect(ebSend).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 7
  it('messages.upsert with neither text nor audio → 400 no_routable_messages', async () => {
    const stubEnvelope = {
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              remoteJid: '46700000000@s.whatsapp.net',
              fromMe: false,
              id: '3A0000000000000077',
            },
            messageTimestamp: NOW,
            pushName: 'Damien',
            message: { reactionMessage: { text: '👍' } },
          },
        ],
        type: 'notify',
      },
    };
    const body = JSON.stringify(stubEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('no_routable_messages');
    expect(ebSend).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------- 8
  it('group jid (ends with @g.us) → is_group=true on emitted detail', async () => {
    const groupEnvelope = {
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: {
              remoteJid: '46700000000-1700000000@g.us',
              fromMe: false,
              id: '3A0000000000000044',
            },
            messageTimestamp: NOW,
            pushName: 'Group Member',
            message: { conversation: 'group hello' },
          },
        ],
        type: 'notify',
      },
    };
    const body = JSON.stringify(groupEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(200);
    const ebCall = ebSend.mock.calls[0]![0] as PutEventsCall;
    const detail = JSON.parse(ebCall.input.Entries[0]!.Detail) as Record<
      string,
      unknown
    >;
    expect(detail.is_group).toBe(true);
    expect(detail.chat_jid).toBe('46700000000-1700000000@g.us');
  });

  // ------------------------------------------------------------------- 9
  it('deterministic capture_id — same (chat_jid, message_key_id) → same id', async () => {
    const body = JSON.stringify(baileysIncomingTextEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({ body, headers: { 'x-baileys-secret': TEST_SECRET } }),
    );
    const firstId = (
      JSON.parse(
        (ebSend.mock.calls[0]![0] as PutEventsCall).input.Entries[0]!.Detail,
      ) as { capture_id: string }
    ).capture_id;
    expect(firstId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Replay the SAME envelope.
    ebSend.mockClear();
    await handler(
      fnUrlEvent({ body, headers: { 'x-baileys-secret': TEST_SECRET } }),
    );
    const secondId = (
      JSON.parse(
        (ebSend.mock.calls[0]![0] as PutEventsCall).input.Entries[0]!.Detail,
      ) as { capture_id: string }
    ).capture_id;
    expect(secondId).toBe(firstId);
  });

  // ------------------------------------------------------------------ 10
  it('detail shapes pass CaptureReceivedWhatsapp{Text,Voice}Schema', async () => {
    // text
    const textBody = JSON.stringify(baileysIncomingTextEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    await handler(
      fnUrlEvent({
        body: textBody,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    );
    const textDetail = JSON.parse(
      (ebSend.mock.calls[0]![0] as PutEventsCall).input.Entries[0]!.Detail,
    );
    expect(() => CaptureReceivedWhatsappTextSchema.parse(textDetail)).not.toThrow();

    // voice
    ebSend.mockClear();
    s3Send.mockClear();
    const voiceBody = JSON.stringify(baileysIncomingVoiceEnvelope);
    await handler(
      fnUrlEvent({
        body: voiceBody,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    );
    const voiceDetail = JSON.parse(
      (ebSend.mock.calls[0]![0] as PutEventsCall).input.Entries[0]!.Detail,
    );
    expect(() =>
      CaptureReceivedWhatsappVoiceSchema.parse(voiceDetail),
    ).not.toThrow();
  });

  // --- supplementary edge-case tests (not numbered in the plan) -----------
  it('non-POST → 405', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ method: 'GET', headers: { 'x-baileys-secret': TEST_SECRET } }),
    )) as Resp;
    expect(res.statusCode).toBe(405);
  });

  it('empty body → 400 empty_body', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({ headers: { 'x-baileys-secret': TEST_SECRET } }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('empty_body');
  });

  it('invalid JSON → 400 invalid_json', async () => {
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const res = (await handler(
      fnUrlEvent({
        body: 'not-json',
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
  });

  it('media fetch returns non-2xx → voice message dropped silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    const body = JSON.stringify(baileysIncomingVoiceEnvelope);
    const mod = await import('../src/handler.js');
    const handler = mod.handler as unknown as AnyHandler;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = (await handler(
      fnUrlEvent({
        body,
        headers: { 'x-baileys-secret': TEST_SECRET },
      }),
    )) as Resp;
    // Single message in fixture, dropped → no_routable_messages.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('no_routable_messages');
    expect(s3Send).not.toHaveBeenCalled();
    expect(ebSend).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
