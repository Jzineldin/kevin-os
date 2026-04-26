/**
 * Email-triage context loader tests (Plan 04-04 Task 2).
 *
 * 3 tests covering:
 *   - @kos/context-loader resolvable → loadContext path returns rich bundle
 *   - @kos/context-loader unresolvable → degraded fallback to local Kevin Context
 *   - both paths return TriageContext shape with kevinContext populated
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pool: getPool returns a stub object (we never query it directly here
// because the @kos/context-loader mock doesn't touch it, and the local
// fallback path is exercised via loadKevinContextBlockLocal mock).
const mockPool = { query: vi.fn() };
vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => mockPool),
  loadKevinContextBlockLocal: vi.fn(async () => '## Current priorities\nlocal-fallback'),
}));

describe('loadTriageContext', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPool.query.mockReset();
  });

  it('@kos/context-loader resolvable → returns rich bundle', async () => {
    vi.doMock('@kos/context-loader', () => ({
      loadContext: vi.fn(async () => ({
        kevin_context: {
          current_priorities: 'Tale Forge fundraise',
          active_deals: '',
          whos_who: '',
          blocked_on: '',
          recent_decisions: '',
          open_questions: '',
        },
        assembled_markdown: '## Dossier\nfull dossier markdown',
        cache_hit: true,
        elapsed_ms: 42,
      })),
    }));
    const { loadTriageContext } = await import('../src/context.js');
    const r = await loadTriageContext({
      entityIds: ['e1', 'e2'],
      ownerId: 'owner',
      captureId: 'cap',
    });
    expect(r.degraded).toBe(false);
    expect(r.cacheHit).toBe(true);
    expect(r.kevinContext).toContain('Tale Forge fundraise');
    expect(r.additionalContextBlock).toContain('full dossier markdown');
  });

  it('@kos/context-loader unresolvable → degraded fallback', async () => {
    vi.doMock('@kos/context-loader', () => {
      throw new Error('module not found');
    });
    const { loadTriageContext } = await import('../src/context.js');
    const r = await loadTriageContext({
      entityIds: [],
      ownerId: 'owner',
      captureId: 'cap',
    });
    expect(r.degraded).toBe(true);
    expect(r.kevinContext).toContain('local-fallback');
    expect(r.additionalContextBlock).toBe('');
  });

  it('TriageContext shape: kevinContext always populated (or empty string on full failure)', async () => {
    vi.doMock('@kos/context-loader', () => {
      throw new Error('module not found');
    });
    const { loadTriageContext } = await import('../src/context.js');
    const r = await loadTriageContext({
      entityIds: [],
      ownerId: 'owner',
      captureId: 'cap',
    });
    expect(r).toHaveProperty('kevinContext');
    expect(r).toHaveProperty('additionalContextBlock');
    expect(r).toHaveProperty('cacheHit');
    expect(r).toHaveProperty('elapsedMs');
    expect(r).toHaveProperty('degraded');
    expect(typeof r.kevinContext).toBe('string');
  });
});
