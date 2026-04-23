import { test } from './fixtures';

// Maps to UI-05 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-11 (PWA install + service worker).
test.describe('pwa-install', () => {
  test.fixme('manifest + service-worker registered, install prompt criteria met', async () => {
    // Assert manifest.webmanifest loads, service worker registers,
    // beforeinstallprompt fires on Android viewport.
  });
});
