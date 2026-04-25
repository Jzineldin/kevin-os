/**
 * Plan 06-04 Task 2 — apps/dashboard timeline proxy route tests.
 *
 * The dashboard route forwards to services/dashboard-api via the
 * Bearer-auth `callApi` helper. After Plan 06-04 the upstream returns
 * MV+overlay rows with `is_live_overlay` flags + `elapsed_ms`. These tests
 * verify the proxy:
 *   - validates uuid path param (400 on garbage)
 *   - forwards optional cursor query param to upstream
 *   - returns the upstream JSON shape verbatim (zod-parsed)
 *   - surfaces upstream errors as 502
 *   - retains is_live_overlay + elapsed_ms in the response payload
 *
 * Mock surface:
 *   `@/lib/dashboard-api` — only `callApi` is consumed by the route.
 *   The mock records the upstream URL so we can assert cursor encoding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const callApiMock = vi.fn();

vi.mock('@/lib/dashboard-api', () => ({
  callApi: callApiMock,
}));

const VALID_UUID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

beforeEach(() => {
  callApiMock.mockReset();
  vi.resetModules();
});

describe('GET /api/entities/:id/timeline', () => {
  it('returns 400 for an invalid uuid path param', async () => {
    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request('http://localhost/api/entities/not-a-uuid/timeline');
    const res = await GET(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_entity_id');
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('happy path: returns items array + elapsed_ms passthrough', async () => {
    const upstreamPayload = {
      rows: [
        {
          id: 'cap-001',
          kind: 'mention' as const,
          occurred_at: '2026-04-24T22:00:00.000Z',
          source: 'granola-transcript',
          context: 'Damien call recap',
          capture_id: 'cap-001',
          href: null,
          is_live_overlay: false,
        },
      ],
      next_cursor: null,
      elapsed_ms: 23,
    };
    callApiMock.mockResolvedValueOnce(upstreamPayload);

    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(`http://localhost/api/entities/${VALID_UUID}/timeline`);
    const res = await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof upstreamPayload;
    expect(body.rows).toHaveLength(1);
    expect(body.elapsed_ms).toBe(23);
    expect(callApiMock).toHaveBeenCalledOnce();
    const [path] = callApiMock.mock.calls[0]!;
    expect(path).toBe(`/entities/${VALID_UUID}/timeline`);
  });

  it('MV-only data: 50 rows returned, none flagged is_live_overlay', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `cap-${String(i).padStart(3, '0')}`,
      kind: 'mention' as const,
      occurred_at: new Date(Date.now() - i * 60_000).toISOString(),
      source: 'granola-transcript',
      context: `event ${i}`,
      capture_id: `cap-${String(i).padStart(3, '0')}`,
      href: null,
      is_live_overlay: false,
    }));
    callApiMock.mockResolvedValueOnce({ rows, next_cursor: 'next', elapsed_ms: 18 });

    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(`http://localhost/api/entities/${VALID_UUID}/timeline`);
    const res = await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    const body = (await res.json()) as { rows: Array<{ is_live_overlay: boolean }> };
    expect(body.rows).toHaveLength(50);
    expect(body.rows.every((r) => r.is_live_overlay === false)).toBe(true);
  });

  it('Live overlay: a fresh mention_events row not in MV is included with is_live_overlay=true', async () => {
    const rows = [
      {
        id: 'cap-fresh',
        kind: 'mention' as const,
        occurred_at: new Date().toISOString(),
        source: 'granola-transcript',
        context: 'just now',
        capture_id: 'cap-fresh',
        href: null,
        is_live_overlay: true,
      },
      {
        id: 'cap-old',
        kind: 'mention' as const,
        occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
        source: 'granola-transcript',
        context: 'an hour ago',
        capture_id: 'cap-old',
        href: null,
        is_live_overlay: false,
      },
    ];
    callApiMock.mockResolvedValueOnce({ rows, next_cursor: null, elapsed_ms: 12 });

    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(`http://localhost/api/entities/${VALID_UUID}/timeline`);
    const res = await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    const body = (await res.json()) as { rows: Array<{ is_live_overlay: boolean; id: string }> };
    expect(body.rows).toHaveLength(2);
    const fresh = body.rows.find((r) => r.id === 'cap-fresh');
    const old = body.rows.find((r) => r.id === 'cap-old');
    expect(fresh?.is_live_overlay).toBe(true);
    expect(old?.is_live_overlay).toBe(false);
  });

  it('forwards cursor query param to upstream, encoded', async () => {
    const cursorB64 = Buffer.from('2026-04-24T22:00:00Z:cap-001', 'utf8').toString('base64');
    callApiMock.mockResolvedValueOnce({ rows: [], next_cursor: null, elapsed_ms: 5 });

    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(
      `http://localhost/api/entities/${VALID_UUID}/timeline?cursor=${encodeURIComponent(cursorB64)}`,
    );
    await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(callApiMock).toHaveBeenCalledOnce();
    const [path] = callApiMock.mock.calls[0]!;
    expect(path).toContain(`cursor=${encodeURIComponent(cursorB64)}`);
  });

  it('upstream rejection → returns 502 upstream_failed', async () => {
    callApiMock.mockRejectedValueOnce(new Error('dashboard-api /entities/.../timeline → 500: boom'));
    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(`http://localhost/api/entities/${VALID_UUID}/timeline`);
    const res = await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('upstream_failed');
  });

  it('rows sorted by occurred_at DESC (proxy preserves upstream order)', async () => {
    const rows = [
      {
        id: 'a',
        kind: 'mention' as const,
        occurred_at: '2026-04-24T22:00:00.000Z',
        source: 's',
        context: '',
        capture_id: 'a',
        href: null,
        is_live_overlay: false,
      },
      {
        id: 'b',
        kind: 'mention' as const,
        occurred_at: '2026-04-24T20:00:00.000Z',
        source: 's',
        context: '',
        capture_id: 'b',
        href: null,
        is_live_overlay: false,
      },
      {
        id: 'c',
        kind: 'mention' as const,
        occurred_at: '2026-04-24T18:00:00.000Z',
        source: 's',
        context: '',
        capture_id: 'c',
        href: null,
        is_live_overlay: false,
      },
    ];
    callApiMock.mockResolvedValueOnce({ rows, next_cursor: null, elapsed_ms: 1 });

    const { GET } = await import('@/app/api/entities/[id]/timeline/route');
    const req = new Request(`http://localhost/api/entities/${VALID_UUID}/timeline`);
    const res = await GET(req, { params: Promise.resolve({ id: VALID_UUID }) });
    const body = (await res.json()) as { rows: Array<{ occurred_at: string }> };
    const ts = body.rows.map((r) => r.occurred_at);
    const sorted = [...ts].sort((a, b) => b.localeCompare(a));
    expect(ts).toEqual(sorted);
  });
});
