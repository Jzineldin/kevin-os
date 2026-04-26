
## From Plan 11-05 execution (2026-04-26)

### Pre-existing typecheck errors in dashboard-api (NOT introduced by 11-05)

`pnpm -F @kos/dashboard-api typecheck` reports 7 errors all pre-dating 11-05:

- `tests/integrations-health.test.ts:223:17` — TS2352 conversion of `undefined` (Plan 11-06 file)
- `tests/integrations-health.test.ts:223:28` — TS2493 tuple length zero (Plan 11-06 file)
- `tests/today.test.ts:383-387` — TS2532 `Object is possibly 'undefined'` (Plan 11-04 file, post-11-04 commit added tests that need null guards)

Verified via `git stash` round-trip on master: the errors reproduce without 11-05 changes. Out of scope for 11-05 (deviation rule scope-boundary). Plan 11-04 / 11-06 verifier or executor should resolve.

### Notes for verifier
- Plan 11-05 changes (calendar.ts handler + tests, contracts/dashboard.ts CalendarEventSchema additive) compile cleanly. The typecheck failures above are not caused by this plan.


### Pre-existing apps/dashboard typecheck errors (NOT introduced by 11-05)

`pnpm -F @kos/dashboard typecheck` reports 3 errors all pre-dating 11-05:

- `src/app/(app)/today/page.tsx:16` — Plan 11-04 introduced captures_today/channels with `default([])` (always-present at runtime), but `EMPTY` literal is typed without those fields. Fix is to add `captures_today: []` and `channels: []` to EMPTY.
- `src/app/(app)/today/page.tsx:27` — Same root cause. The Schema applies defaults so the parsed object is required, but the `data` value type is the input shape with `optional/.default` interpreted as optional.
- `src/components/dashboard/ChannelHealth.tsx:76` — Next.js typed-routes refusal of `/integrations-health` because Plan 11-06 hasn't yet added the `(app)/integrations-health/page.tsx` file (which materialises the route). Will resolve when 11-06 lands.

Verified pre-existing via `git stash --keep-index` round-trip on master. Out of scope for 11-05 (deviation rule scope-boundary).

## From Plan 11-08 execution (2026-04-26)

### `services/triage/src/handler.ts` LinkedIn DM body→text typecheck error (NOT introduced by 11-08)

`pnpm -r typecheck` fails on `services/triage/src/handler.ts:105`:

```
src/handler.ts(105,18): error TS2339: Property 'text' does not exist on type
'{ capture_id: string; channel: "linkedin"; kind: "linkedin_dm";
   received_at: string; conversation_urn: string; message_urn: string;
   from: { name: string; li_public_id?: string | undefined; };
   body: string; sent_at: string; }'.
```

Introduced by upstream commit `d5a1eac` ("fix(triage): dispatch chrome_highlight + linkedin_dm captures", PR #38) — the dispatched event uses `body` but the handler reads `d.text`. Reproduced on the worktree base branch before any Plan 11-08 changes.

Out of scope for Plan 11-08 (Phase 11 scope is dashboard frontend rebuild + real-data wiring + button audit; LinkedIn capture pipeline is Phase 5). Owner: whoever next touches `services/triage` — fix is a one-line `d.text` → `d.body ?? ''`.

### Pre-existing test-fixture typecheck error fixed in 11-08 (Rule 3)

`packages/test-fixtures/src/dashboard/index.ts:93` — `makeTodayResponse()` did not provide `captures_today` or `channels` after Plan 11-04 made them required (with schema-level `.default([])`). This is exactly the same shape of error 11-05 flagged for `today/page.tsx`'s EMPTY literal, in a different file. Fixed inline in this plan because `pnpm -r typecheck` is gating evidence for the phase gate — Rule 3 (auto-fix blocking issues) applies.

