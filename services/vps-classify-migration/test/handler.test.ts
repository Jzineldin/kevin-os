/**
 * @kos/service-vps-classify-migration — Wave 0 scaffold tests.
 *
 * Plan 10-00 ships TWO tests here:
 *   - One real test that confirms the handler module resolves + exports a
 *     callable named `handler`. This guards against "handler renamed but
 *     CDK still references the old name" regressions across waves.
 *   - One `it.todo` placeholder reserving the Wave-1 HMAC-mismatch test.
 *     Wave 1 (Plan 10-01) flips it from `todo` to a real assertion.
 */
import { describe, it, expect } from 'vitest';

describe('vps-classify-migration / handler (Wave 0 scaffold)', () => {
  it('exports a `handler` function from src/handler.ts', async () => {
    const mod = await import('../src/handler.js');
    expect(typeof mod.handler).toBe('function');
  });

  // Wave 1 (Plan 10-01) replaces with a real HMAC mismatch → 401 assertion.
  it.todo('rejects requests with mismatched HMAC signature with statusCode 401');
});
