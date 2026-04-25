/**
 * @kos/dashboard-listen-relay — in-memory FIFO ring buffer for SSE events.
 *
 * Holds the last `max` events received from Postgres NOTIFY on the `kos_output`
 * channel. Each push assigns a monotonically increasing `seq` so the long-poll
 * endpoint can use `seq` as a cursor.
 *
 * Per 03-CONTEXT.md D-24 + 03-RESEARCH.md §13: MAX=256, in-memory only.
 * Restart-loss is acceptable — SSE clients reconnect, missed events recovered
 * via full-query `router.refresh()` on next navigation.
 */
import type { SseEvent } from '@kos/contracts/dashboard';

export type SseEventWithSeq = SseEvent & { seq: number };

export class RingBuffer {
  private items: SseEventWithSeq[] = [];
  private nextSeq = 1;
  public readonly max: number;

  constructor(max = 256) {
    this.max = max;
  }

  push(ev: SseEvent): number {
    const row: SseEventWithSeq = { ...ev, seq: this.nextSeq++ };
    this.items.push(row);
    while (this.items.length > this.max) this.items.shift();
    return row.seq;
  }

  since(cursor: number): SseEventWithSeq[] {
    return this.items.filter((e) => e.seq > cursor);
  }

  get size(): number {
    return this.items.length;
  }

  get maxSeq(): number {
    return this.nextSeq - 1;
  }
}
