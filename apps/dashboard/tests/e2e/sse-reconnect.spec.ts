import { test } from './fixtures';

// Maps to UI-06 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-06 (SSE route handler + long-poll relay).
test.describe('sse-reconnect', () => {
  test.fixme('EventSource auto-reconnects within 1s of stream close', async () => {
    // Open page with SSE attached, kill upstream stream, assert client
    // reconnects and the next server push is rendered.
  });
});
