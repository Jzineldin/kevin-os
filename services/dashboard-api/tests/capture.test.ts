/**
 * Capture POST handler — body validation + ULID shape + publish plumbing.
 *
 * We mock `src/events.js` so the handler never opens an EventBridge
 * connection during tests. Live PutEvents coverage lives under e2e.
 *
 * Using vi.mock (hoisted) + a lazy access pattern to avoid the
 * "cannot access before initialization" hoist trap — the mock module
 * declares the fn, and we pull a reference back out inside beforeEach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/events.js', () => {
  const publishCapture = vi.fn(async (_detail: object) => undefined);
  const publishOutput = vi.fn(async (_kind: string, _detail: object) => undefined);
  return {
    publishCapture,
    publishOutput,
    __setEventsClientForTest: vi.fn(),
  };
});

// Import AFTER the mock is registered.
import { captureHandler } from '../src/handlers/capture.js';
import * as events from '../src/events.js';

const publishCaptureMock = events.publishCapture as unknown as ReturnType<typeof vi.fn>;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

beforeEach(() => {
  publishCaptureMock.mockClear();
  publishCaptureMock.mockImplementation(async () => undefined);
});

function makeCtx(body: unknown) {
  return {
    method: 'POST' as const,
    path: '/capture',
    params: {},
    query: {},
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
  };
}

describe('POST /capture', () => {
  it('returns 202 + ULID capture_id for valid text body', async () => {
    const res = await captureHandler(makeCtx({ text: 'Hello from Kevin' }));
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { capture_id: string; received_at: string };
    expect(body.capture_id).toMatch(ULID_RE);
    expect(Number.isNaN(new Date(body.received_at).getTime())).toBe(false);
  });

  it('publishes to kos.capture with ULID + source:dashboard', async () => {
    await captureHandler(makeCtx({ text: 'x' }));
    expect(publishCaptureMock).toHaveBeenCalledTimes(1);
    const args = publishCaptureMock.mock.calls[0] as unknown as [
      { capture_id: string; source: string; text?: string; received_at: string },
    ];
    const detail = args[0];
    expect(detail.capture_id).toMatch(ULID_RE);
    expect(detail.source).toBe('dashboard');
    expect(detail.text).toBe('x');
  });

  it('accepts audio_s3 alone (text absent)', async () => {
    const res = await captureHandler(
      makeCtx({ audio_s3: 'https://kos-audio.s3.eu-north-1.amazonaws.com/2026/04/23/cap.m4a' }),
    );
    expect(res.statusCode).toBe(202);
    expect(publishCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when both text and audio_s3 missing', async () => {
    const res = await captureHandler(makeCtx({}));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid_body');
    expect(publishCaptureMock).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const res = await captureHandler(makeCtx('not-json{'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when audio_s3 is not a URL', async () => {
    const res = await captureHandler(makeCtx({ audio_s3: 'not-a-url' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when publishCapture throws', async () => {
    publishCaptureMock.mockRejectedValueOnce(new Error('eb-unavailable'));
    const res = await captureHandler(makeCtx({ text: 'x' }));
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('eventbridge_publish_failed');
  });
});
