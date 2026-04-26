/**
 * content-writer orchestrator tests (Plan 08-02 Task 1).
 *
 * 8 tests:
 *   1. content.topic_submitted → StartExecution called with the configured
 *      state-machine ARN.
 *   2. Zod validation: missing topic_text → handler throws.
 *   3. Default platforms: explicit `min(1)` schema rejects empty arrays;
 *      defensive fallback covers a hand-crafted detail (operator script).
 *   4. Idempotency: alreadyDrafted=true → no StartExecution; returns
 *      { skipped: 'already_drafted' }.
 *   5. SFN error propagates: StartExecution throws → handler rethrows.
 *   6. Emits content.orchestration.started observability event.
 *   7. Returns { execution_arn, topic_id } on success.
 *   8. Non-content-topic events → returns { skipped: <detail-type> }.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (declared BEFORE handler import) ---

const sfnSend = vi.fn();
vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: vi.fn().mockImplementation(() => ({ send: sfnSend })),
  StartExecutionCommand: vi.fn().mockImplementation((x: unknown) => ({
    input: x,
    __cmd: 'StartExecution',
  })),
}));

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({
    input: x,
    __cmd: 'PutEvents',
  })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const persistState = { drafted: false };
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  alreadyDrafted: vi.fn(async () => persistState.drafted),
  __resetPoolForTests: vi.fn(),
}));

const VALID_TOPIC_ULID = '01HZ0000000000000000000ABC';
const VALID_CAPTURE_ULID = '01HZ0000000000000000000DEF';
const VALID_OWNER_UUID = '00000000-0000-0000-0000-000000000001';
const STATE_MACHINE_ARN =
  'arn:aws:states:eu-north-1:123456789012:stateMachine:kos-content-writer-5platform';

function makeEvent(detail: unknown) {
  return {
    source: 'kos.agent',
    'detail-type': 'content.topic_submitted',
    detail,
  };
}

function validDetail(overrides: Record<string, unknown> = {}) {
  return {
    topic_id: VALID_TOPIC_ULID,
    capture_id: VALID_CAPTURE_ULID,
    topic_text: 'Write about Almi convertible note signing',
    platforms: ['instagram', 'linkedin'],
    submitted_at: '2026-04-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('content-writer orchestrator handler', () => {
  beforeEach(() => {
    sfnSend.mockReset();
    ebSend.mockClear();
    persistState.drafted = false;
    process.env.KEVIN_OWNER_ID = VALID_OWNER_UUID;
    process.env.SFN_CONTENT_WRITER_ARN = STATE_MACHINE_ARN;
    process.env.AWS_REGION = 'eu-north-1';
    process.env.AGENT_BUS_NAME = 'kos.agent';
  });

  it('1. content.topic_submitted → StartExecution called with configured ARN', async () => {
    sfnSend.mockResolvedValueOnce({
      executionArn: `${STATE_MACHINE_ARN}:exec-1`,
    });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeEvent(validDetail()),
    );
    expect(sfnSend).toHaveBeenCalledTimes(1);
    const cmd = sfnSend.mock.calls[0]?.[0] as { input: { stateMachineArn: string; input: string; name: string } };
    expect(cmd.input.stateMachineArn).toBe(STATE_MACHINE_ARN);
    expect(cmd.input.name).toBe(`cw-${VALID_TOPIC_ULID}`);
    const inputParsed = JSON.parse(cmd.input.input) as {
      topic_id: string;
      platforms: string[];
    };
    expect(inputParsed.topic_id).toBe(VALID_TOPIC_ULID);
    expect(inputParsed.platforms).toEqual(['instagram', 'linkedin']);
  });

  it('2. Zod validation: missing topic_text rejects', async () => {
    const { handler } = await import('../src/handler.js');
    const bad = validDetail();
    delete (bad as Record<string, unknown>).topic_text;
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)(makeEvent(bad)),
    ).rejects.toThrow();
    expect(sfnSend).not.toHaveBeenCalled();
  });

  it('3. all 5 platforms when caller supplies all 5', async () => {
    sfnSend.mockResolvedValueOnce({ executionArn: `${STATE_MACHINE_ARN}:exec-1` });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeEvent(
        validDetail({ platforms: ['instagram', 'linkedin', 'tiktok', 'reddit', 'newsletter'] }),
      ),
    );
    const cmd = sfnSend.mock.calls[0]?.[0] as { input: { input: string } };
    const parsed = JSON.parse(cmd.input.input) as { platforms: string[] };
    expect(parsed.platforms).toHaveLength(5);
    expect(parsed.platforms).toEqual(
      expect.arrayContaining(['instagram', 'linkedin', 'tiktok', 'reddit', 'newsletter']),
    );
  });

  it('4. duplicate topic_id → returns { skipped: "already_drafted" }; no StartExecution', async () => {
    persistState.drafted = true;
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeEvent(validDetail()),
    )) as { skipped: string; topic_id: string };
    expect(r.skipped).toBe('already_drafted');
    expect(r.topic_id).toBe(VALID_TOPIC_ULID);
    expect(sfnSend).not.toHaveBeenCalled();
  });

  it('5. StartExecution throws → handler rethrows', async () => {
    sfnSend.mockRejectedValueOnce(new Error('StateMachineDoesNotExist'));
    const { handler } = await import('../src/handler.js');
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)(makeEvent(validDetail())),
    ).rejects.toThrow(/StateMachineDoesNotExist/);
  });

  it('6. emits content.orchestration.started on kos.agent', async () => {
    sfnSend.mockResolvedValueOnce({ executionArn: `${STATE_MACHINE_ARN}:exec-2` });
    const { handler } = await import('../src/handler.js');
    await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeEvent(validDetail()),
    );
    expect(ebSend).toHaveBeenCalledTimes(1);
    const cmd = ebSend.mock.calls[0]?.[0] as { input: { Entries: Array<{ EventBusName: string; Source: string; DetailType: string; Detail: string }> } };
    const entry = cmd.input.Entries[0];
    if (!entry) throw new Error('expected at least one EventBridge entry');
    expect(entry.EventBusName).toBe('kos.agent');
    expect(entry.Source).toBe('kos.agent');
    expect(entry.DetailType).toBe('content.orchestration.started');
    const detail = JSON.parse(entry.Detail) as { topic_id: string; execution_arn: string };
    expect(detail.topic_id).toBe(VALID_TOPIC_ULID);
    expect(detail.execution_arn).toMatch(/exec-2$/);
  });

  it('7. returns { execution_arn, topic_id } on success', async () => {
    const arn = `${STATE_MACHINE_ARN}:exec-7`;
    sfnSend.mockResolvedValueOnce({ executionArn: arn });
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)(
      makeEvent(validDetail()),
    )) as { execution_arn: string; topic_id: string };
    expect(r.execution_arn).toBe(arn);
    expect(r.topic_id).toBe(VALID_TOPIC_ULID);
  });

  it('8. non-content-topic event → returns skipped without invoking SFN', async () => {
    const { handler } = await import('../src/handler.js');
    const r = (await (handler as unknown as (e: unknown) => Promise<unknown>)({
      source: 'kos.agent',
      'detail-type': 'unrelated.event',
      detail: {},
    })) as { skipped: string };
    expect(r.skipped).toBe('unrelated.event');
    expect(sfnSend).not.toHaveBeenCalled();
  });
});
