/**
 * handler.test.ts — dossier-loader EventBridge handler tests.
 *
 * Phase 6 Plan 06-05 Task 3 (INF-10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const persistState = {
  writes: [] as Array<{ ownerId: string; entityId: string; lastTouchHash: string }>,
};

vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })),
  writeDossierCache: vi.fn(async (opts: { ownerId: string; entityId: string; lastTouchHash: string }) => {
    persistState.writes.push({
      ownerId: opts.ownerId,
      entityId: opts.entityId,
      lastTouchHash: opts.lastTouchHash,
    });
  }),
}));

vi.mock('../src/aggregate.js', () => ({
  aggregateEntityCorpus: vi.fn(async () => ({
    markdown: '# Entity: Damien\n- entity_id: 11111111-1111-1111-1111-111111111111',
    chars: 80,
    sections: 1,
    truncated: false,
  })),
}));

vi.mock('../src/vertex.js', () => ({
  callGeminiWithCache: vi.fn(async () => ({
    response_text: '## Damien dossier\nFull picture.',
    tokens_input: 100_000,
    tokens_output: 1_000,
    cost_estimate_usd: 0.135,
  })),
}));

const tagSpy = vi.fn();
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));

const ENTITY_A = '11111111-1111-1111-1111-111111111111';
const ENTITY_B = '22222222-2222-2222-2222-222222222222';
const OWNER = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  persistState.writes = [];
  tagSpy.mockClear();
  process.env.AWS_REGION = 'eu-north-1';
});

describe('dossier-loader handler', () => {
  it('happy path: writes entity_dossiers_cached with gemini-full: prefix per entity', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      version: '0',
      id: 'evt-1',
      'detail-type': 'context.full_dossier_requested',
      source: 'kos.agent',
      account: '123',
      time: new Date().toISOString(),
      region: 'eu-north-1',
      resources: [],
      detail: {
        capture_id: 'cap-1',
        owner_id: OWNER,
        entity_ids: [ENTITY_A, ENTITY_B],
        requested_by: 'operator',
        intent: 'load Damien + Almi full dossier',
        requested_at: new Date().toISOString(),
      },
    };
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)(event)) as {
      status: string;
      entity_count: number;
      tokens_input: number;
      cost_estimate_usd: number;
    };
    expect(result.status).toBe('ok');
    expect(result.entity_count).toBe(2);
    expect(result.tokens_input).toBe(100_000);
    expect(result.cost_estimate_usd).toBe(0.135);
    expect(persistState.writes).toHaveLength(2);
    for (const w of persistState.writes) {
      expect(w.ownerId).toBe(OWNER);
      expect(w.lastTouchHash).toMatch(/^gemini-full:/);
    }
    const entityIdsWritten = persistState.writes.map((w) => w.entityId).sort();
    expect(entityIdsWritten).toEqual([ENTITY_A, ENTITY_B]);
  });

  it('rejects empty entity_ids via Zod (FullDossierRequestedSchema.min(1))', async () => {
    // WR-05: FullDossierRequestedSchema enforces z.array(...).min(1), so
    // empty entity_ids arrays are rejected at Zod.parse time. The handler
    // no longer carries a redundant length-check branch; invalid input
    // surfaces as a schema parse error, not a 'skipped' status.
    const { handler } = await import('../src/handler.js');
    const event = {
      version: '0',
      id: 'evt-2',
      'detail-type': 'context.full_dossier_requested',
      source: 'kos.agent',
      account: '123',
      time: new Date().toISOString(),
      region: 'eu-north-1',
      resources: [],
      detail: {
        capture_id: 'cap-2',
        owner_id: OWNER,
        entity_ids: [],
        requested_by: 'operator',
        intent: 'noop',
        requested_at: new Date().toISOString(),
      },
    };
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)(event),
    ).rejects.toBeDefined();
  });

  it('Zod parse failure on detail throws', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      version: '0',
      id: 'evt-3',
      'detail-type': 'context.full_dossier_requested',
      source: 'kos.agent',
      account: '123',
      time: new Date().toISOString(),
      region: 'eu-north-1',
      resources: [],
      detail: { not_a_dossier_request: true },
    };
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)(event),
    ).rejects.toBeDefined();
  });

  it('tagTraceWithCaptureId called with capture_id from event detail', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      version: '0',
      id: 'evt-4',
      'detail-type': 'context.full_dossier_requested',
      source: 'kos.agent',
      account: '123',
      time: new Date().toISOString(),
      region: 'eu-north-1',
      resources: [],
      detail: {
        capture_id: 'cap-trace-99',
        owner_id: OWNER,
        entity_ids: [ENTITY_A],
        requested_by: 'operator',
        intent: 'trace test',
        requested_at: new Date().toISOString(),
      },
    };
    await (handler as unknown as (e: unknown) => Promise<unknown>)(event);
    expect(tagSpy).toHaveBeenCalledWith('cap-trace-99');
  });
});
