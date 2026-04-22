/**
 * Triage handler unit tests (Plan 02-04 Task 1).
 *
 * Three behavioural tests:
 *   - text capture branch publishes triage.routed with source_kind='text'
 *   - voice transcribed branch publishes triage.routed with source_kind='voice'
 *   - D-21 idempotency: prior ok run → no PutEvents
 *
 * Bedrock + EventBridge + Postgres are all mocked; the handler exercises
 * the contract wiring between event-shape parsing, idempotency check, and
 * downstream PutEvents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (declared BEFORE handler import so vi.mock hoisting wins) ------

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

const pgState = { prior: false, runs: [] as unknown[] };
vi.mock('../src/persist.js', () => ({
  findPriorOkRun: vi.fn(async () => pgState.prior),
  insertAgentRun: vi.fn(async (r: Record<string, unknown>) => {
    pgState.runs.push({ ...r, status: 'started' });
    return 'run-1';
  }),
  updateAgentRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    pgState.runs.push({ id, ...patch });
  }),
  loadKevinContextBlock: vi.fn(async () => '## Current priorities\nTale Forge'),
}));

vi.mock('../src/agent.js', () => ({
  runTriageAgent: vi.fn(async () => ({
    output: {
      route: 'voice-capture',
      detected_type: 'task',
      urgency: 'med',
      reason: 'ping task',
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    rawText: '{}',
  })),
}));

vi.mock('@sentry/aws-serverless', () => ({
  init: vi.fn(),
  wrapHandler: (h: unknown) => h,
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  flush: vi.fn(async () => {}),
}));

const ULID_TEXT = '01HABCDEFGHJKMNPQRSTVWXYZ0';
const ULID_VOICE = '01HABCDEFGHJKMNPQRSTVWXYZ1';
const ULID_DUP = '01HABCDEFGHJKMNPQRSTVWXYZ2';

describe('triage handler', () => {
  beforeEach(() => {
    ebSend.mockClear();
    pgState.prior = false;
    pgState.runs = [];
    process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('text capture → PutEvents triage.routed with route=voice-capture, source_kind=text', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: {
        capture_id: ULID_TEXT,
        channel: 'telegram',
        kind: 'text',
        text: 'Ping Damien om convertible loan',
        sender: { id: 1 },
        received_at: new Date().toISOString(),
        telegram: { chat_id: 1, message_id: 1 },
      },
    });
    const call = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('triage.routed'),
    );
    expect(call).toBeDefined();
    const detail = JSON.parse(
      (call as unknown as [{ input: { Entries: { Detail: string }[] } }])[0].input
        .Entries[0]!.Detail,
    );
    expect(detail.route).toBe('voice-capture');
    expect(detail.source_kind).toBe('text');
    expect(detail.source_text).toBe('Ping Damien om convertible loan');
    expect(detail.sender.id).toBe(1);
    expect(detail.telegram.chat_id).toBe(1);
  });

  it('voice transcribed → PutEvents triage.routed with source_kind=voice', async () => {
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.voice.transcribed',
      detail: {
        capture_id: ULID_VOICE,
        channel: 'telegram',
        kind: 'voice',
        text: 'möte med Damien om Almi',
        raw_ref: {
          s3_bucket: 'b',
          s3_key: 'k',
          duration_sec: 5,
          mime_type: 'audio/ogg',
        },
        sender: { id: 1 },
        received_at: new Date().toISOString(),
        transcribed_at: new Date().toISOString(),
        telegram: { chat_id: 1, message_id: 1 },
        vocab_name: 'kos-sv-se-v1',
      },
    });
    const call = ebSend.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('triage.routed'),
    );
    expect(call).toBeDefined();
    const detail = JSON.parse(
      (call as unknown as [{ input: { Entries: { Detail: string }[] } }])[0].input
        .Entries[0]!.Detail,
    );
    expect(detail.source_kind).toBe('voice');
    expect(detail.source_text).toBe('möte med Damien om Almi');
  });

  it('idempotent: prior ok run → no PutEvents fires', async () => {
    pgState.prior = true;
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: {
        capture_id: ULID_DUP,
        channel: 'telegram',
        kind: 'text',
        text: 'x',
        sender: { id: 1 },
        received_at: new Date().toISOString(),
        telegram: { chat_id: 1, message_id: 1 },
      },
    });
    expect(ebSend).not.toHaveBeenCalled();
  });
});
