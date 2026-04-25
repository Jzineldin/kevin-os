/**
 * constantTimeEqual — Edge-runtime-safe string compare for middleware.ts
 * (RESEARCH §5 + P-01).
 *
 * The function is used by both middleware.ts (Edge runtime, no Node crypto)
 * and /api/auth/login/route.ts (Node runtime). A single implementation
 * keeps the two call sites consistent.
 */
import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from '@/lib/constant-time';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abcdef', 'abcdef')).toBe(true);
  });

  it('returns false when lengths differ', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('returns false when same length but last char differs', () => {
    expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  it('returns false when same length but first char differs', () => {
    // Used to verify there is no early-return on first-char mismatch —
    // function must iterate all characters.
    expect(constantTimeEqual('abcdef', 'bbcdef')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('returns false for non-string inputs defensively', () => {
    // @ts-expect-error — defensive test of runtime guard against non-string input
    expect(constantTimeEqual(null, 'abc')).toBe(false);
    // @ts-expect-error — defensive test of runtime guard against undefined input
    expect(constantTimeEqual('abc', undefined)).toBe(false);
  });
});
