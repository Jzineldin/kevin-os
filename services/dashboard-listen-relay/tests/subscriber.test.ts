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

describe('subscriber', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.RDS_PROXY_ENDPOINT = 'fake-proxy.example.com';
    process.env.AWS_REGION = 'eu-north-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fakeSubRef.current = null;
  });

  it('pushes valid NOTIFY payload into buffer (parsed from string)', async () => {
    const { RingBuffer } = await import('../src/buffer.js');
    const { startSubscriber } = await import('../src/subscriber.js');
    const buf = new RingBuffer(10);
    await startSubscriber(buf);
    const sub = fakeSubRef.current!;
    expect(sub.listenedTo).toContain('kos_output');

    sub.notifications.emit(
      'kos_output',
      JSON.stringify({ kind: 'inbox_item', id: 'abc', ts: '2026-04-23T10:00:00Z' }),
    );
    expect(buf.size).toBe(1);
    expect(buf.since(0)[0]?.id).toBe('abc');
  });

  it('accepts parsed object payload directly', async () => {
    const { RingBuffer } = await import('../src/buffer.js');
    const { startSubscriber } = await import('../src/subscriber.js');
    const buf = new RingBuffer(10);
    await startSubscriber(buf);
    const sub = fakeSubRef.current!;

    sub.notifications.emit('kos_output', {
      kind: 'timeline_event',
      id: 'abc',
      entity_id: '550e8400-e29b-41d4-a716-446655440000',
      ts: '2026-04-23T10:00:00Z',
    });
    expect(buf.size).toBe(1);
    expect(buf.since(0)[0]?.kind).toBe('timeline_event');
  });

  it('drops malformed payload and warns (missing kind)', async () => {
    const { RingBuffer } = await import('../src/buffer.js');
    const { startSubscriber } = await import('../src/subscriber.js');
    const buf = new RingBuffer(10);
    await startSubscriber(buf);
    const sub = fakeSubRef.current!;

    sub.notifications.emit('kos_output', JSON.stringify({ id: 'abc', ts: '2026-04-23T10:00:00Z' }));
    expect(buf.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops malformed payload and warns (unknown kind)', async () => {
    const { RingBuffer } = await import('../src/buffer.js');
    const { startSubscriber } = await import('../src/subscriber.js');
    const buf = new RingBuffer(10);
    await startSubscriber(buf);
    const sub = fakeSubRef.current!;

    sub.notifications.emit(
      'kos_output',
      JSON.stringify({ kind: 'not_a_kind', id: 'abc', ts: '2026-04-23T10:00:00Z' }),
    );
    expect(buf.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
