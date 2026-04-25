import { describe, it } from 'vitest';

// Maps to INF-12 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-03 (SigV4 client + dashboard-api round-trip).
describe('api-layer SigV4 round-trip', () => {
  it.todo('signs GET /today with scoped IAM creds and parses zod response');
  it.todo('retries once on 5xx and surfaces typed error on second failure');
});
