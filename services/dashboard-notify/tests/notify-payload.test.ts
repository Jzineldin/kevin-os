import { describe, it } from 'vitest';

// Wave 0 stub — wired in plan 03-06 (NOTIFY payload contract).
describe('NOTIFY payload', () => {
  it.todo('pointer-only payload serialises to <8KB (Postgres NOTIFY cap)');
  it.todo('rejects detail-type not in SseEventKindSchema enum');
});
