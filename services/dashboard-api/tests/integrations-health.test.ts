/**
 * Integrations-health handler contract test (Phase 11 Plan 11-06).
 *
 * The /integrations/health endpoint aggregates per-channel last-success
 * timestamps from the agent_runs table (verified granular in Wave 0 schema
 * verification: telegram-bot, gmail-poller, granola-poller, calendar-reader,
 * linkedin-webhook, chrome-webhook, etc.).
 *
 * Wave 0 ships a single skipped placeholder. Wave 2 (Plan 11-06) implements
 * the handler + replaces this skip with the real assertions:
 *   - vi.hoisted db.execute mock returning agent_runs aggregation rows
 *   - assert handler classifies status: healthy | degraded | down
 *   - assert IntegrationsHealthResponseSchema.parse() round-trip
 *   - assert scheduler rows (morning-brief, day-close, weekly-review)
 *     are surfaced separately from capture channels
 */
import { describe, it } from 'vitest';

describe('integrations-health handler (Phase 11 Plan 11-06)', () => {
  it.skip(
    'aggregates per-channel last-success from agent_runs',
    async () => {
      // Wave 2 implements. Mirror email-drafts.test.ts pattern:
      //   1. vi.hoisted({ ebSendMock })
      //   2. fakeDb.execute table-driven mock returning agent_runs rows
      //   3. import handler dynamically after __clearRoutesForTest()
      //   4. call handler with empty Ctx; assert IntegrationsHealthResponseSchema
    },
  );

  it.skip(
    'classifies channel status from time-since-last-ok-run',
    async () => {
      // healthy if last_ok_at > now() - 2× expected_interval
      // degraded if 2× < age < 4×
      // down if older
    },
  );

  it.skip(
    'surfaces schedulers (morning-brief, day-close, weekly-review) in separate list',
    async () => {
      // schedulers and channels are returned in separate arrays per
      // IntegrationsHealthResponseSchema (channels[] + schedulers[]).
    },
  );
});
