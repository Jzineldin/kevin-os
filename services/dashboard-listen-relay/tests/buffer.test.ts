import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/buffer.js';
import type { SseEvent } from '@kos/contracts/dashboard';

function mkEv(id: string): SseEvent {
  return { kind: 'inbox_item', id, ts: '2026-04-23T10:00:00Z' };
}

describe('RingBuffer', () => {
  it('pushes events and assigns monotonically increasing seq', () => {
    const buf = new RingBuffer(10);
    const s1 = buf.push(mkEv('a'));
    const s2 = buf.push(mkEv('b'));
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(buf.maxSeq).toBe(2);
    expect(buf.size).toBe(2);
  });

  it('caps at max size and evicts oldest (FIFO)', () => {
    const buf = new RingBuffer(256);
    for (let i = 0; i < 300; i++) buf.push(mkEv(`e${i}`));
    expect(buf.size).toBe(256);
    expect(buf.maxSeq).toBe(300);
    const all = buf.since(0);
    expect(all[0]?.seq).toBe(45);
    expect(all[all.length - 1]?.seq).toBe(300);
  });

  it('since(cursor) returns only events newer than cursor in FIFO order', () => {
    const buf = new RingBuffer(10);
    for (let i = 0; i < 5; i++) buf.push(mkEv(`e${i}`));
    const tail = buf.since(2);
    expect(tail.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('since(maxSeq) returns empty array', () => {
    const buf = new RingBuffer(10);
    buf.push(mkEv('a'));
    buf.push(mkEv('b'));
    expect(buf.since(2)).toEqual([]);
  });

  it('respects custom max', () => {
    const buf = new RingBuffer(3);
    buf.push(mkEv('a'));
    buf.push(mkEv('b'));
    buf.push(mkEv('c'));
    buf.push(mkEv('d'));
    expect(buf.size).toBe(3);
    const all = buf.since(0);
    expect(all.map((e) => e.id)).toEqual(['b', 'c', 'd']);
  });
});
