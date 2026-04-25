import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

type FakeSubscriber = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  listenTo: (ch: string) => Promise<unknown>;
  notifications: EventEmitter;
  events: EventEmitter;
  listenedTo: string[];
};
const fakeSubRef: { current: FakeSubscriber | null } = { current: null };

vi.mock('pg-listen', () => ({
  default: vi.fn(() => {
    const sub: FakeSubscriber = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listenTo: vi.fn(async (ch: string) => {
        sub.listenedTo.push(ch);
        return undefined;
      }),
      notifications: new EventEmitter(),
      events: new EventEmitter(),
      listenedTo: [],
    };
    fakeSubRef.current = sub;
    return sub;
  }),
}));

vi.mock('@aws-sdk/rds-signer', () => {
  class Signer {
    constructor(_: unknown) {}
    async getAuthToken() {
      return 'fake-iam-token';
    }
  }
  return { Signer };
});

describe('long-poll /events', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.RDS_PROXY_ENDPOINT = 'fake-proxy.example.com';
    process.env.AWS_REGION = 'eu-north-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fakeSubRef.current = null;
  });

  it('returns empty events + cursor immediately when buffer empty and wait=0', async () => {
    const { buildApp } = await import('../src/index.js');
    const { app, buffer } = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/events?cursor=0&wait=0' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events).toEqual([]);
      expect(body.cursor).toBe(0);
      expect(buffer.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns buffered events immediately when present', async () => {
    const { buildApp } = await import('../src/index.js');
    const { app, buffer, subscriber } = await buildApp();
    try {
      subscriber.notifications.emit(
        'kos_output',
        JSON.stringify({ kind: 'inbox_item', id: 'a', ts: '2026-04-23T10:00:00Z' }),
      );
      const res = await app.inject({ method: 'GET', url: '/events?cursor=0&wait=25' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events).toHaveLength(1);
      expect(body.events[0].id).toBe('a');
      expect(body.cursor).toBe(1);
      expect(buffer.size).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('times out after wait seconds when no new events (wait capped at 25)', async () => {
    const { buildApp } = await import('../src/index.js');
    const { app } = await buildApp();
    try {
      const t0 = Date.now();
      const res = await app.inject({ method: 'GET', url: '/events?cursor=0&wait=1' });
      const elapsed = Date.now() - t0;
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await app.close();
    }
  }, 10_000);

  it('/healthz returns 200 with buffered + max_seq after subscriber connected', async () => {
    const { buildApp } = await import('../src/index.js');
    const { app, subscriber } = await buildApp();
    try {
      subscriber.events.emit('connected');
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.buffered).toBe('number');
      expect(typeof body.max_seq).toBe('number');
    } finally {
      await app.close();
    }
  });

  it('/healthz returns 500 before subscriber connected', async () => {
    const { buildApp } = await import('../src/index.js');
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.ok).toBe(false);
    } finally {
      await app.close();
    }
  });
});
