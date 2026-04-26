# Plan 08-01 — Agent execution notes (CAP-09 Google Calendar reader)

Executed in worktree `agent-a9b8c6029650c6548` on the `phase-02-wave-5-gaps`
branch. Not committed — operator review pending.

## Files added / modified

### services/calendar-reader (new source + tests)

| File | Purpose | Lines |
|------|---------|------:|
| `services/calendar-reader/src/oauth.ts` | refresh_token → access_token exchange + module-scope cache (TTL=expires_in − 10 min) | 134 |
| `services/calendar-reader/src/gcal.ts` | events.list wrapper (native fetch, single-events expansion, all-day handling, 401 → `code='auth_stale'` error) | 122 |
| `services/calendar-reader/src/persist.ts` | RDS Proxy IAM pool + `upsertCalendarEvents` UPSERT on `(event_id, account)` PK with inserted/updated/unchanged counts | 158 |
| `services/calendar-reader/src/handler.ts` | full handler: parallel both-account poll + 401-retry-once + `kos.capture` event emit + Sentry/OTel wiring | 260 |
| `services/calendar-reader/test/oauth.test.ts` | 4 tests (Secrets-Manager fetch, cache TTL, invalid_grant actionable error, missing-secret error) | 119 |
| `services/calendar-reader/test/gcal.test.ts` | 5 tests (URL params, all-day vs timed mapping, Bearer header, 401 auth_stale, recurring expansion) | 156 |
| `services/calendar-reader/test/handler.test.ts` | 6 tests (parallel poll, upsert counts, fetch window, 401 retry-then-give-up, kos.capture emit, idempotent re-poll) | 286 |
| `services/calendar-reader/package.json` | added @langfuse/otel + @opentelemetry/* + @arizeai/* + @sentry/aws-serverless deps for `_shared/tracing.ts` | +6 deps |
| `services/calendar-reader/tsconfig.json` | added `../_shared/**/*.ts` to include[] (mirrors granola-poller) | +1 line |

**Test count: 15 / 15 pass.**

### packages/context-loader (extension)

| File | Change |
|------|--------|
| `packages/context-loader/src/calendar.ts` | NEW — `loadCalendarWindow(pool, ownerId, windowHours=48)` + `formatCalendarMarkdown(rows)` (skips heading when rows empty) |
| `packages/context-loader/src/loadContext.ts` | `LoadContextInput.includeCalendar?: boolean`; calendar fetched in the same `Promise.all` as Azure + linked-projects (no p95 widening for non-opt-in callers); markdown appended after dossier sections (cache-stable Kevin Context prefix preserved); return type widened to `ContextBundleWithCalendar` (back-compatible structural extension of `ContextBundle`) |
| `packages/context-loader/src/index.ts` | barrel exports for `loadCalendarWindow`, `formatCalendarMarkdown`, `CalendarWindowRow`, `CalendarWindowAttendee`, `ContextBundleWithCalendar` |
| `packages/context-loader/test/calendar.test.ts` | 6 tests (SQL filters, ASC sort, windowHours param, empty-row no-heading, timed format, all-day format) |
| `packages/context-loader/test/includeCalendar.test.ts` | 4 tests (48 h window query when flag set, no SQL hit when flag unset, calendar heading injected, empty-window omitted) |

**Test count: 10 new + 30 existing = 40 / 40 pass (backward compat intact).**

### packages/cdk

| File | Change |
|------|--------|
| `packages/cdk/lib/stacks/integrations-calendar-reader.ts` | NEW — `wireCalendarReader` helper. Provisions Lambda (Node 22 / arm64 / 512 MB / 60 s), `CfnSchedule` `calendar-reader-30min` (`cron(0/30 * * * ? *)` Europe/Stockholm), grants secretsmanager:GetSecretValue on the two `kos/gcal-oauth-*` secrets, rds-db:connect as `kos_agent_writer`, events:PutEvents on `kos.capture`. Resolves OAuth secrets by name via `Secret.fromSecretNameV2` so secret lifecycle is operator-owned. ~190 lines. |
| `packages/cdk/lib/stacks/integrations-stack.ts` | Imported `wireCalendarReader` + `CalendarReaderWiring`; added `calendarReader?: CalendarReaderWiring` field; called helper inside the existing `if (props.kevinOwnerId)` block (re-uses `notion.schedulerRole` so all schedules share one trust policy). |
| `packages/cdk/test/integrations-calendar-reader.test.ts` | 6 tests (Schedule name, cron + tz + OFF, runtime/arch/memory/timeout, env vars, IAM has rds/events/secrets, IAM does NOT have bedrock/ses/postiz/notion). |

**CDK test count: 6 / 6 pass.**

### scripts/bootstrap-gcal-oauth.mjs

Replaced the Plan 08-00 stub with the full operator flow:
- Argument parser (`--account kevin-elzarka|kevin-taleforge`)
- Env vars `GCAL_CLIENT_ID` + `GCAL_CLIENT_SECRET` required
- Builds the consent URL with `scope=calendar.readonly`, `access_type=offline`, `prompt=consent`, random `state`
- Local HTTP listener on `127.0.0.1:9788/callback` (state-mismatch guard)
- Code → refresh_token exchange via `oauth2.googleapis.com/token`
- Writes `kos/gcal-oauth-<account>` Secrets Manager (PutSecretValueCommand → fall-through to CreateSecretCommand on `ResourceNotFoundException`)
- Verification one-liner printed at the end

`node --check` passes.

## Verification log

| Command | Result |
|---------|--------|
| `pnpm --filter @kos/service-calendar-reader test` | 15 / 15 ✓ |
| `pnpm --filter @kos/context-loader test` | 40 / 40 ✓ (10 new + 30 existing) |
| `pnpm --filter @kos/cdk test --reporter=basic -- --run integrations-calendar-reader` | 6 / 6 ✓ |
| `pnpm --filter @kos/service-calendar-reader exec tsc --noEmit` | clean |
| `pnpm --filter @kos/context-loader exec tsc --noEmit` | clean |
| `pnpm --filter @kos/cdk exec tsc --noEmit` | clean |
| `node --check scripts/bootstrap-gcal-oauth.mjs` | OK |

## Design choices not strictly in plan

- **`Secret.fromSecretNameV2` over passing `ISecret` props:** keeps secret lifecycle operator-owned (the bootstrap script can `CreateSecret` if absent or `PutSecretValue` if present without CDK fighting it). Helper still accepts pre-built `ISecret` refs via `gcalSecretElzarka` / `gcalSecretTaleforge` props for tests / future consolidation.
- **`CfnSchedule` (L1) instead of L2 `Schedule` + `LambdaInvoke`:** the rest of the repo uses `CfnSchedule` (notion / granola / mv-refresher / lifecycle / discord). Sticking with the same construct keeps the scheduler-role pattern (no `aws:SourceArn` condition per the Phase 1 Plan 02-04 retro) consistent.
- **Reader handler returns full result with `ok` + `failed` shapes** instead of just `{ events: number }`. Lets the dashboard's "last calendar sync" badge surface partial-success states (one account healthy, the other refresh_token revoked) without scraping CloudWatch.
- **`upsertCalendarEvents` returns inserted/updated/unchanged counts** via a CTE that uses `xmax = 0` to discriminate insert-vs-conflict at row-level. Plan asked for the breakdown; this is the cheapest one-roundtrip way to get it on PostgreSQL.
- **`ContextBundleWithCalendar` structural type** instead of mutating `ContextBundleSchema` in `@kos/contracts`: the schema change would force every downstream consumer to update at once. The structural extension keeps Phase 1-7 callers unchanged; only Phase 8 / Phase 7-AUTO consumers narrow the wider type.
- **`calendar_window: []` (not `undefined`) when `includeCalendar=true` but no rows match:** lets callers distinguish "asked but empty" from "did not ask" without a separate flag.

## Operator runbook (post-merge)

Once this lands and CDK deploys:

1. Create GCP project (or reuse the Tale Forge / Outbehaving project).
2. Enable the Google Calendar API.
3. Create OAuth client ID of type "Web application"; add `http://127.0.0.1:9788/callback` to authorised redirect URIs.
4. Note the `client_id` + `client_secret`.
5. Run twice:
   ```bash
   GCAL_CLIENT_ID='...' GCAL_CLIENT_SECRET='...' \
     node scripts/bootstrap-gcal-oauth.mjs --account kevin-elzarka

   GCAL_CLIENT_ID='...' GCAL_CLIENT_SECRET='...' \
     node scripts/bootstrap-gcal-oauth.mjs --account kevin-taleforge
   ```
   (sign in to the matching Google identity in each browser session).

## RDS grants required (out-of-band, deploy-time)

The Lambda authenticates as `kos_agent_writer`. The role + grant are
already in scope from prior phases (granola-poller / mv-refresher use the
same user). New grant required for the calendar_events_cache table:

```sql
GRANT SELECT, INSERT, UPDATE ON calendar_events_cache TO kos_agent_writer;
```

If the operator hasn't run this yet, the first scheduled invocation fails
with `permission denied for table calendar_events_cache`.

## Known caveats

- Google's OAuth consent screen enters "Testing" status by default and
  silently expires refresh tokens after 7 days for unverified clients with
  external user types. Single-user use with Kevin's own Google project +
  the consent screen set to "in production" (Internal application is N/A
  outside Workspace) avoids this. Document in the runbook before first run.
- `prompt=consent` + `access_type=offline` is required to receive a fresh
  `refresh_token` on every consent. Without `prompt=consent`, Google returns
  no `refresh_token` for accounts that previously consented. The script
  surfaces an actionable error pointing at `https://myaccount.google.com/permissions`.
- The 30-min cadence balances dashboard freshness (D-15) vs Google's
  10 000 reads/day quota. Both accounts × 48 invocations/day × ~5 events =
  far below quota; the cron expression `cron(0/30 * * * ? *)` fires at :00
  and :30 in the Stockholm timezone.
- D-32 idempotency holds even on re-poll within a minute: same
  `(event_id, account, updated_at)` tuple → `unchanged` count increments,
  no row writes occur (the `WHERE calendar_events_cache.updated_at <
  EXCLUDED.updated_at` clause in the UPSERT).
- `calendar_window` returned by `loadContext` carries the empty array when
  the caller opts in but the horizon is empty — distinguishable from
  `undefined` (caller did not opt in).
