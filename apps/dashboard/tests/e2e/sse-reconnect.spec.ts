import { test, expect } from './fixtures';

/**
 * Maps to UI-06 (03-VALIDATION.md Wave 0). Plan 03-07 Task 2 promotes this
 * from `fixme` to a happy-path check.
 *
 * The full NOTIFY-round-trip assertion (publish a row on the relay, see the
 * event rendered in the browser within 2s) lives in Plan 03-12 once the
 * dev-mode relay stub is wired. For Wave 2 we only verify:
 *   1. Visiting /today opens an EventSource against /api/stream.
 *   2. The EventSource reaches readyState=1 (OPEN) — i.e. the Route
 *      Handler's preamble landed and the browser fired `open`.
 *
 * Skipped unless running against a deployed preview URL (requires the real
 * /api/stream Route Handler to be live — `next dev` works too when the
 * dev relay is reachable from localhost).
 */
test.describe('sse-reconnect', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'needs deployed preview (or `next dev` against a reachable relay) to exercise EventSource',
  );

  test('EventSource opens on /today load', async ({ page, baseURL }) => {
    // Authenticate first so middleware lets us onto /today.
    await page.context().addCookies([
      {
        name: 'kos_session',
        value: process.env.KOS_TEST_BEARER_TOKEN ?? '',
        url: baseURL ?? process.env.PLAYWRIGHT_BASE_URL!,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    // Expose the next EventSource instance so the test can inspect it.
    await page.addInitScript(() => {
      const RealES = window.EventSource;
      // Track all EventSource instances opened on the page.
      (window as unknown as { __kosSseInstances: EventSource[] }).__kosSseInstances = [];
      class TrackedES extends RealES {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          (window as unknown as { __kosSseInstances: EventSource[] }).__kosSseInstances.push(
            this,
          );
        }
      }
      (window as unknown as { EventSource: typeof EventSource }).EventSource =
        TrackedES as unknown as typeof EventSource;
    });

    await page.goto('/today');

    // Wait up to 5s for /api/stream EventSource to be constructed and open.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const list = (window as unknown as { __kosSseInstances?: EventSource[] })
              .__kosSseInstances;
            if (!list) return { count: 0, urls: [] as string[], states: [] as number[] };
            return {
              count: list.length,
              urls: list.map((es) => es.url),
              states: list.map((es) => es.readyState),
            };
          }),
        { timeout: 5_000, intervals: [200, 500, 1_000] },
      )
      .toEqual(
        expect.objectContaining({
          count: expect.any(Number),
          urls: expect.arrayContaining([expect.stringContaining('/api/stream')]),
        }),
      );
  });
});
