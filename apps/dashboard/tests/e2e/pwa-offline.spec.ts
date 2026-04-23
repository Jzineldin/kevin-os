import { test } from './fixtures';

// Maps to UI-05 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-11 (offline banner + 24h SWR cache).
test.describe('pwa-offline', () => {
  test.fixme('Today view renders from SW cache when offline', async () => {
    // Set context.offline = true, reload /, expect cached Today HTML +
    // "Offline · last synced {ts}" banner.
  });
});
