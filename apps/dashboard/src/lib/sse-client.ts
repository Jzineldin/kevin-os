/**
 * sse-client — pure helpers for the browser-side SseProvider (Plan 03-07
 * Task 2). Kept separate from the React component so the reducer-ish logic
 * is testable without jsdom + a fake EventSource wiring.
 *
 *   - BACKOFF_MIN / BACKOFF_MAX: 500ms floor -> 60s cap per RESEARCH R-12.
 *   - nextBackoff(prev): doubles up to the cap. Deterministic (no jitter at
 *     this scale — single user, single browser tab, single cap).
 *   - parseMessage(raw): JSON-parses the EventSource data and validates
 *     against the shared SseEventSchema. Returns null on any failure so
 *     the provider can silently drop garbage (T-3-07-03 mitigation).
 */
import type { SseEvent } from '@kos/contracts/dashboard';
import { SseEventSchema } from '@kos/contracts/dashboard';

export const BACKOFF_MIN = 500;
export const BACKOFF_MAX = 60_000;

export function nextBackoff(prev: number): number {
  const doubled = prev * 2;
  if (!Number.isFinite(doubled) || doubled <= 0) return BACKOFF_MAX;
  return Math.min(doubled, BACKOFF_MAX);
}

export function parseMessage(raw: string): SseEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = SseEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export type SseStatus = 'idle' | 'connecting' | 'open' | 'closed';
