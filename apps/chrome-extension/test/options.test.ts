/**
 * Phase 5 / Plan 05-01 Task 2 — Options page persistence test.
 *
 * Verifies the storage helper roundtrip on top of the @kos/test-fixtures
 * MV3 stub. The full options.ts UI logic (DOM-bound) is exercised only
 * via vitest's jsdom DOM env in a future plan; this test asserts the
 * surface contract (saveConfig + loadConfig) used by Save and Test Ping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installMV3Stub } from '@kos/test-fixtures';

describe('options persistence', () => {
  beforeEach(() => {
    installMV3Stub();
  });

  it('saveConfig + loadConfig roundtrip', async () => {
    const { saveConfig, loadConfig } = await import('../src/lib/storage');
    await saveConfig({
      webhookUrl: 'https://x.test',
      bearer: 'abc',
      hmacSecret: 'shh',
    });
    const out = await loadConfig();
    expect(out.webhookUrl).toBe('https://x.test');
    expect(out.bearer).toBe('abc');
    expect(out.hmacSecret).toBe('shh');
  });

  it('isConfigured: false until all three set', async () => {
    const { saveConfig, isConfigured } = await import('../src/lib/storage');
    expect(await isConfigured()).toBe(false);
    await chrome.storage.local.set({ bearer: 'abc' });
    expect(await isConfigured()).toBe(false);
    await saveConfig({
      webhookUrl: 'https://x.test',
      bearer: 'abc',
      hmacSecret: 'shh',
    });
    expect(await isConfigured()).toBe(true);
  });
});
