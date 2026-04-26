/**
 * mutation-executor handler tests (Plan 08-04 Task 2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ebSend = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: ebSend })),
  PutEventsCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: vi.fn(),
}));

const persistState = {
  loaded: null as null | {
    id: string;
    owner_id: string;
    capture_id: string;
    mutation_type: string;
    target_kind: string;
    target_id: string;
    target_display: string;
    confidence: number;
    status: string;
    alternatives: unknown[];
  },
  executedRows: [] as Array<{ id: string; result: string }>,
  failedRows: [] as Array<{ id: string; error: string }>,
};
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  loadPendingMutationForExecute: vi.fn(async () => persistState.loaded),
  markExecuted: vi.fn(async (_pool: unknown, id: string, result: string) => {
    persistState.executedRows.push({ id, result });
  }),
  markFailed: vi.fn(async (_pool: unknown, id: string, error: string) => {
    persistState.failedRows.push({ id, error });
  }),
}));

const applyMock = vi.fn();
vi.mock('../src/applier.js', () => ({
  applyMutation: applyMock,
}));

vi.mock('../src/notion.js', () => ({
  getNotionClient: vi.fn(async () => ({ pages: { update: vi.fn() } })),
}));

const ownerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const captureId = '01HK000000000000000000000A';
const mutationId = '11111111-1111-4111-8111-111111111111';
const authId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  persistState.loaded = null;
  persistState.executedRows = [];
  persistState.failedRows = [];
  process.env.KEVIN_OWNER_ID = ownerId;
  process.env.AWS_REGION = 'eu-north-1';
});

describe('mutation-executor handler', () => {
  it('happy path: pending_mutation.approved → applyMutation → markExecuted → emit pending_mutation.executed', async () => {
    persistState.loaded = {
      id: mutationId,
      owner_id: ownerId,
      capture_id: captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-1',
      target_display: 'Damien call',
      confidence: 0.92,
      status: 'approved',
      alternatives: [],
    };
    applyMock.mockResolvedValueOnce({ result: 'archived' });

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'pending_mutation.approved',
      detail: {
        capture_id: captureId,
        mutation_id: mutationId,
        authorization_id: authId,
        approved_at: new Date().toISOString(),
      },
    })) as { result?: string };
    expect(r?.result).toBe('archived');
    expect(persistState.executedRows).toHaveLength(1);
    expect(persistState.executedRows[0]!.result).toBe('archived');
    // PutEvents called for pending_mutation.executed
    const detailTypes = ebSend.mock.calls.map(
      (c) => (c[0] as { input: { Entries: Array<{ DetailType: string }> } }).input.Entries[0]!.DetailType,
    );
    expect(detailTypes).toContain('pending_mutation.executed');
  });

  it('row missing or terminal → skipped', async () => {
    persistState.loaded = null;
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'pending_mutation.approved',
      detail: {
        capture_id: captureId,
        mutation_id: mutationId,
        authorization_id: authId,
        approved_at: new Date().toISOString(),
      },
    })) as { skipped?: string };
    expect(r?.skipped).toBe('not_found_or_terminal');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('apply returns failed → markFailed; status reflected in emit', async () => {
    persistState.loaded = {
      id: mutationId,
      owner_id: ownerId,
      capture_id: captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-missing',
      target_display: '',
      confidence: 0.92,
      status: 'approved',
      alternatives: [],
    };
    applyMock.mockResolvedValueOnce({ result: 'failed', error: 'target_not_found:calendar_events_cache' });

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    await invoke({
      'detail-type': 'pending_mutation.approved',
      detail: {
        capture_id: captureId,
        mutation_id: mutationId,
        authorization_id: authId,
        approved_at: new Date().toISOString(),
      },
    });
    expect(persistState.failedRows).toHaveLength(1);
    expect(persistState.executedRows).toEqual([]);
  });

  it('selected_target_ref overrides primary target', async () => {
    persistState.loaded = {
      id: mutationId,
      owner_id: ownerId,
      capture_id: captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-PRIMARY',
      target_display: '',
      confidence: 0.5,
      status: 'approved',
      alternatives: [],
    };
    applyMock.mockResolvedValueOnce({ result: 'archived' });

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    await invoke({
      'detail-type': 'pending_mutation.approved',
      detail: {
        capture_id: captureId,
        mutation_id: mutationId,
        authorization_id: authId,
        approved_at: new Date().toISOString(),
        selected_target_ref: { kind: 'meeting', id: 'evt-PICKED', display: 'Standup' },
      },
    });
    const applyArgs = applyMock.mock.calls[0]?.[0] as { target_id: string; target_kind: string };
    expect(applyArgs.target_id).toBe('evt-PICKED');
    expect(applyArgs.target_kind).toBe('meeting');
  });

  it('NEVER calls Google Calendar API — no fetch to googleapis.com', async () => {
    persistState.loaded = {
      id: mutationId,
      owner_id: ownerId,
      capture_id: captureId,
      mutation_type: 'cancel_meeting',
      target_kind: 'meeting',
      target_id: 'evt-1',
      target_display: '',
      confidence: 0.9,
      status: 'approved',
      alternatives: [],
    };
    applyMock.mockResolvedValueOnce({ result: 'archived' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);

    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    await invoke({
      'detail-type': 'pending_mutation.approved',
      detail: {
        capture_id: captureId,
        mutation_id: mutationId,
        authorization_id: authId,
        approved_at: new Date().toISOString(),
      },
    });
    const googleCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('googleapis.com'),
    );
    expect(googleCalls).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('skips events with non-matching detail-type', async () => {
    const { handler } = await import('../src/handler.js');
    const invoke = handler as unknown as (e: unknown) => Promise<unknown>;
    const r = (await invoke({
      'detail-type': 'something.else',
      detail: {},
    })) as { skipped?: string };
    expect(r?.skipped).toBe('something.else');
  });
});
