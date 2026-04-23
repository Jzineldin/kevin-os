import { describe, it } from 'vitest';

// Wave 0 stub — wired in plan 03-06 (pg-listen reconnect + buffer).
describe('pg-listen reconnect', () => {
  it.todo('reconnects LISTEN within 1s of Postgres restart');
  it.todo('buffered events flush to next long-poll consumer without loss');
});
