import { describe, it } from 'vitest';

// Maps to UI-06 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-06 (dashboard-notify -> NOTIFY -> SSE relay -> EventSource).
describe('NOTIFY -> EventSource integration', () => {
  it.todo('dashboard-notify Lambda writes a pointer-only NOTIFY payload <8KB');
  it.todo('listen-relay long-poll flushes the same event to the SSE Route Handler');
});
