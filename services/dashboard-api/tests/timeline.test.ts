import { describe, it } from 'vitest';

// Wave 0 stub — wired in plan 03-05 (entity timeline endpoint).
describe('timeline endpoint', () => {
  it.todo('GET /entities/:id/timeline returns 50 rows + cursor');
  it.todo('cursor pagination is stable across live inserts (ORDER BY occurred_at, id)');
});
