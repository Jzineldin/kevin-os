/**
 * Capture POST handler — body validation + ULID shape + EventBridge publish.
 *
 * Uses aws-sdk-client-mock to intercept the EventBridgeClient so tests
 * never touch AWS. Live publish coverage lives under e2e.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { captureHandler } from '../src/handlers/capture.js';
import { __setEventsClientForTest } from '../src/events.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ebMock = mockClient(EventBridgeClient);

beforeEach(() => {
  ebMock.reset();
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e-1' }] });
  // Inject a fresh EventBridgeClient so the mock intercepts calls.
  __setEventsClientForTest(new EventBridgeClient({ region: 'eu-north-1' }));
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

  it('publishes to kos.capture bus with capture.received detail-type', async () => {
    await captureHandler(makeCtx({ text: 'x' }));
    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls.length).toBe(1);
    const entry = calls[0]!.args[0].input.Entries![0]!;
    expect(entry.EventBusName).toBe('kos.capture');
    expect(entry.DetailType).toBe('capture.received');
    expect(entry.Source).toBe('kos.dashboard');
    const detail = JSON.parse(entry.Detail!) as { capture_id: string; source: string };
    expect(detail.capture_id).toMatch(ULID_RE);
    expect(detail.source).toBe('dashboard');
  });

  it('accepts audio_s3 alone (text absent)', async () => {
    const res = await captureHandler(
      makeCtx({ audio_s3: 'https://kos-audio.s3.eu-north-1.amazonaws.com/2026/04/23/cap.m4a' }),
    );
    expect(res.statusCode).toBe(202);
  });

  it('returns 400 when both text and audio_s3 missing', async () => {
    const res = await captureHandler(makeCtx({}));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('returns 400 when body is not valid JSON', async () => {
    const res = await captureHandler(makeCtx('not-json{'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when audio_s3 is not a URL', async () => {
    const res = await captureHandler(makeCtx({ audio_s3: 'not-a-url' }));
    expect(res.statusCode).toBe(400);
  });
});
