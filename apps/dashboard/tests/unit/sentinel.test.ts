import { describe, it, expect } from 'vitest';

// Scaffold sentinel — ensures `vitest run` always has at least one
// passing test while the real unit suites are being authored in
// Wave-1+ plans. Safe to delete once a real test exists.
describe('scaffold sentinel', () => {
  it('boots the vitest runner in jsdom env', () => {
    expect(typeof window).toBe('object');
  });
});
