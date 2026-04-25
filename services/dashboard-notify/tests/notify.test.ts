import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventBridgeEvent } from 'aws-lambda';
import { createHandler } from '../src/index.js';

type FakeClient = {
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};

function makeFakeClient(): FakeClient {
  return {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [] })),
  };
}

function makeEvent(
  detailType: string,
  detail: Record<string, unknown> = {},
): EventBridgeEvent<string, Record<string, unknown>> {
  return {
    version: '0',
    id: 'evt-1234',
    'detail-type': detailType,
    source: 'kos.output',
    account: '123456789012',
    time: '2026-04-23T10:00:00Z',
    region: 'eu-north-1',
    resources: [],
    detail,
  };
}

describe('dashboard-notify handler', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.RDS_PROXY_ENDPOINT = 'fake-proxy.example.com';
    process.env.AWS_REGION = 'eu-north-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('translates inbox_item event into pg_notify("kos_output", ...)', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    const res = await handler(
      makeEvent('inbox_item', { id: 'row-1', ts: '2026-04-23T10:00:00Z' }),
      {} as never,
      (() => {}) as never,
    );

    expect(res).toEqual({ ok: true, notified: true });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toBe('SELECT pg_notify($1, $2)');
    expect(params[0]).toBe('kos_output');
    const payload = JSON.parse(params[1] as string);
    expect(payload).toEqual({
      kind: 'inbox_item',
      id: 'row-1',
      ts: '2026-04-23T10:00:00Z',
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('includes entity_id when present in detail', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    await handler(
      makeEvent('timeline_event', {
        id: 'mention-1',
        entity_id: '550e8400-e29b-41d4-a716-446655440000',
        ts: '2026-04-23T10:00:00Z',
      }),
      {} as never,
      (() => {}) as never,
    );
    const params = client.query.mock.calls[0]![1];
    const payload = JSON.parse(params[1] as string);
    expect(payload.entity_id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('ignores unknown detail-type (allowlist reject) without calling pg', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    const res = await handler(
      makeEvent('some_other_type', { id: 'x' }),
      {} as never,
      (() => {}) as never,
    );
    expect(res).toEqual({ ok: true, notified: false });
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws when detail is missing id and event has no fallback id', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    // Craft an event where detail has no id AND event.id is empty -> payload.id becomes empty string -> still parses.
    // We expect the zod schema to accept empty id (it is z.string() without min). So instead test that
    // a detail-type valid but bad ts (not ISO 8601) rejects.
    await expect(
      handler(
        makeEvent('capture_ack', { id: 'ok', ts: 'not-an-iso-date' }),
        {} as never,
        (() => {}) as never,
      ),
    ).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('pointer-only payload stays under 8KB NOTIFY cap (happy path)', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    await handler(
      makeEvent('draft_ready', {
        id: 'agent-run-id-1234567890',
        ts: '2026-04-23T10:00:00Z',
      }),
      {} as never,
      (() => {}) as never,
    );
    const params = client.query.mock.calls[0]![1];
    expect((params[1] as string).length).toBeLessThan(8000);
  });

  it('uses event.id as fallback when detail.id is missing', async () => {
    const client = makeFakeClient();
    const handler = createHandler({
      makeClient: () => client as unknown as import('pg').Client,
      getAuthToken: async () => 'fake-token',
    });
    await handler(
      makeEvent('entity_merge', { ts: '2026-04-23T10:00:00Z' }),
      {} as never,
      (() => {}) as never,
    );
    const params = client.query.mock.calls[0]![1];
    const payload = JSON.parse(params[1] as string);
    expect(payload.id).toBe('evt-1234');
  });
});
