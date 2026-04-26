/**
 * mutation-proposer handler integration tests (Plan 08-04 Task 1).
 *
 * Mocks every external dependency (Bedrock, Postgres, EventBridge,
 * Sentry, Langfuse, @kos/context-loader) and asserts the full 3-stage
 * dispatch path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const persistState = {
  priorOk: false,
  pendingExists: false,
  insertedRows: [] as Array<Record<string, unknown>>,
  agentRunStatus: 'started' as 'started' | 'ok' | 'error',
  agentRunOutput: undefined as unknown,
};
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({
    query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
  })),
  findPriorOkRun: vi.fn(async () => persistState.priorOk),
  insertAgentRun: vi.fn(async () => 'run-1'),
  updateAgentRun: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    persistState.agentRunStatus = patch.status as typeof persistState.agentRunStatus;
    persistState.agentRunOutput = patch.outputJson;
  }),
  insertPendingMutation: vi.fn(async (_pool: unknown, input: Record<string, unknown>) => {
    persistState.insertedRows.push(input);
    return { id: input.id as string, alreadyExists: persistState.pendingExists };
  }),
}));

const classifyMock = vi.fn();
const decideMock = vi.fn();
vi.mock('../src/classifier.js', () => ({
  classifyMutation: classifyMock,
  decideTarget: decideMock,
}));

const candidatesMock = vi.fn();
vi.mock('../src/target-resolver.js', () => ({
  gatherTargetCandidates: candidatesMock,
}));

vi.mock('@kos/context-loader', () => ({
  loadKevinContextMarkdown: vi.fn(async () => '## Kevin Context\nx'),
  loadContext: vi.fn(async () => ({ assembled_markdown: '## Context\ny' })),
}));

const captureId = '01HK000000000000000000000A';
const ownerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  vi.clearAllMocks();
  persistState.priorOk = false;
  persistState.pendingExists = false;
  persistState.insertedRows = [];
  persistState.agentRunStatus = 'started';
  persistState.agentRunOutput = undefined;
  process.env.KEVIN_OWNER_ID = ownerId;
  process.env.AWS_REGION = 'eu-north-1';
});

describe('mutation-proposer handler', () => {
  it('happy path: text capture → regex → Haiku → Sonnet → INSERT pending_mutations + emit', async () => {
    classifyMock.mockResolvedValueOnce({
      is_mutation: true,
      mutation_type: 'cancel_meeting',
      confidence: 0.92,
      reasoning: '',
    });
    candidatesMock.mockResolvedValueOnce([
      { kind: 'meeting', id: 'evt-1', display: 'Damien call @ 11:00' },
    ]);
    decideMock.mockResolvedValueOnce({
      selected_target: {
        kind: 'meeting',
        id: 'evt-1',
        display: 'Damien call @ 11:00',
        confidence: 0.91,
      },
      alternatives: [],
      reasoning: 'explicit reference',
    });

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'ta bort mötet imorgon kl 11',
      },
    })) as { proposed?: string };

    expect(r?.proposed).toBeDefined();
    expect(persistState.insertedRows).toHaveLength(1);
    expect(persistState.insertedRows[0]!.mutationType).toBe('cancel_meeting');
    // Emit event fired
    expect(ebSend).toHaveBeenCalled();
    const sendCall = ebSend.mock.calls[0]?.[0] as { input?: { Entries?: Array<{ DetailType?: string }> } };
    expect(sendCall?.input?.Entries?.[0]?.DetailType).toBe('pending_mutation.proposed');
  });

  it('non-imperative text → regex skips → no DB write', async () => {
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'mötet kl 11 imorgon',
      },
    })) as { skipped?: string };
    expect(r?.skipped).toBe('not_imperative');
    expect(persistState.insertedRows).toEqual([]);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('regex matches but Haiku says is_mutation=false → false_positive (no Sonnet, no DB)', async () => {
    classifyMock.mockResolvedValueOnce({
      is_mutation: false,
      mutation_type: 'none',
      confidence: 0.9,
      reasoning: 'subscription out of KOS scope',
    });

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'cancel the subscription',
      },
    })) as { skipped?: string };
    expect(r?.skipped).toBe('false_positive');
    expect(decideMock).not.toHaveBeenCalled();
    expect(persistState.insertedRows).toEqual([]);
    expect(persistState.agentRunStatus).toBe('ok');
    const out = persistState.agentRunOutput as { decision: string };
    expect(out.decision).toBe('false_positive');
  });

  it('Haiku confidence below 0.7 threshold → low_confidence (no Sonnet)', async () => {
    classifyMock.mockResolvedValueOnce({
      is_mutation: true,
      mutation_type: 'cancel_meeting',
      confidence: 0.5,
      reasoning: '',
    });
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'cancel the meeting',
      },
    })) as { skipped?: string };
    expect(r?.skipped).toBe('low_confidence');
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('idempotent: same capture_id processed twice → second call short-circuits', async () => {
    persistState.priorOk = true;
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'ta bort mötet',
      },
    })) as { idempotent?: boolean };
    expect(r?.idempotent).toBe(true);
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('no candidates → no_target_candidates (no Sonnet, no DB write)', async () => {
    classifyMock.mockResolvedValueOnce({
      is_mutation: true,
      mutation_type: 'cancel_meeting',
      confidence: 0.9,
      reasoning: '',
    });
    candidatesMock.mockResolvedValueOnce([]);
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'capture.received',
      detail: {
        capture_id: captureId,
        kind: 'text',
        text: 'cancel the meeting',
      },
    })) as { skipped?: string };
    expect(r?.skipped).toBe('no_target_candidates');
    expect(decideMock).not.toHaveBeenCalled();
    expect(persistState.insertedRows).toEqual([]);
  });
});
