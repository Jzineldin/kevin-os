# Phase 10 Plan 10-03 — Agent Execution Notes

Wave 2, MIG-03: archive 5 legacy Brain DBs in Notion with write-ahead
event_log audit trail. Plan executed end-to-end without committing.

## Files created

```
scripts/migrate-brain-dbs.mjs                                                506
scripts/verify-brain-dbs-archived.mjs                                        205
scripts/verify-brain-db-archive-ordering.mjs                                 285
scripts/.notion-brain-dbs.example.json                                        10
.planning/phases/10-migration-decommission/10-03-BRAIN-DB-ARCHIVE-RUNBOOK.md 271
```

## Files modified

```
.gitignore   +4 lines  (ignore scripts/.notion-brain-dbs.json — operator's real UUIDs)
```

## Plan verify (Task 1 / Task 2 / Task 3)

All three plan-defined `<verify><automated>` greps pass:

```
$ node --check scripts/migrate-brain-dbs.mjs && \
  test -f scripts/.notion-brain-dbs.example.json && \
  grep -q 'REPLACE_WITH_NOTION_UUID' scripts/.notion-brain-dbs.example.json && \
  grep -q '\[MIGRERAD-' scripts/migrate-brain-dbs.mjs && \
  grep -q 'INSERT INTO event_log' scripts/migrate-brain-dbs.mjs && \
  grep -q 'databases.update' scripts/migrate-brain-dbs.mjs && \
  grep -q -- '--dry-run' scripts/migrate-brain-dbs.mjs && \
  grep -q -- '--force' scripts/migrate-brain-dbs.mjs && \
  grep -A5 'INSERT INTO event_log' scripts/migrate-brain-dbs.mjs | \
    grep -q 'notion.databases.update\|await notion'
TASK1_VERIFY_OK

$ node --check scripts/verify-brain-dbs-archived.mjs && \
  node --check scripts/verify-brain-db-archive-ordering.mjs && \
  grep -q 'archived === true' scripts/verify-brain-dbs-archived.mjs && \
  grep -q 'MIGRERAD-' scripts/verify-brain-dbs-archived.mjs && \
  grep -q 'ordering' scripts/verify-brain-db-archive-ordering.mjs && \
  grep -q 'event_log' scripts/verify-brain-dbs-archived.mjs
TASK2_VERIFY_OK

$ test -f .planning/phases/10-migration-decommission/10-03-BRAIN-DB-ARCHIVE-RUNBOOK.md && \
  grep -q 'MIGRERAD-|MIG-04|Lock database|90 days|Rollback|DRY_RUN_EVIDENCE' \
       .planning/phases/10-migration-decommission/10-03-BRAIN-DB-ARCHIVE-RUNBOOK.md
TASK3_VERIFY_OK
```

## Ordering invariant test (live run)

```
$ node scripts/verify-brain-db-archive-ordering.mjs
[PASS] ordering: happy path: ordering = retrieve → INSERT event_log → update Notion → UPDATE event_log
[PASS] ordering: failure mode 1: pg.INSERT throws → notion.databases.update is NEVER called
[PASS] ordering: failure mode 2: notion.update throws → audit row already committed (no rollback/delete)
[PASS] ordering: idempotency: already-archived + [MIGRERAD-] prefix → skip without writing event_log
[PASS] ordering: --force: already-archived + [MIGRERAD-] prefix → re-archive with stripped prefix
[SUMMARY] ordering tests pass=5 fail=0 (of 5)
```

Run-time: ~144 ms with `KOS_NOTION_RETRY_DELAYS_MS=1,1,1` (the test
file sets this default). Without the override the failure-mode test
sleeps the production backoff (1+5+15s) before assertions — correct
behaviour, slow CI.

The ordering test asserts D-12:
1. `pg.query(INSERT INTO event_log ...)` runs strictly BEFORE
   `notion.databases.update` on the happy path.
2. If `pg.query` throws, `notion.databases.update` is NEVER called.
3. If `notion.databases.update` throws, the INSERT row stays committed
   (no `ROLLBACK` / `DELETE FROM event_log` is issued).
4. Already-archived + `[MIGRERAD-]` prefix → skip without writing
   event_log (idempotent).
5. `--force` strips an existing `[MIGRERAD-DATE]` prefix and re-applies
   today's date (no doubled prefix).

The test uses hand-rolled `pg` + `notion` mocks (no vitest dependency)
so it is runnable in any Node 22+ environment via plain
`node scripts/verify-brain-db-archive-ordering.mjs`.

## --help output (verified live)

```
$ node scripts/migrate-brain-dbs.mjs --help
Usage: node scripts/migrate-brain-dbs.mjs [options]

Archive the 5 legacy Brain DBs in Notion with write-ahead event_log audit.

Options:
  --dry-run            Print proposed changes; no event_log write, no Notion mutation.
  --force              Re-archive even if already archived (overwrites title prefix).
  --db-id <uuid>       Archive only this Brain DB id (must be in the inventory file).
  --owner-id <uuid>    Override KEVIN_OWNER_ID for the event_log row.
  -h, --help           Show this help and exit.

Inventory file: scripts/.notion-brain-dbs.json (gitignored).
Template file:  scripts/.notion-brain-dbs.example.json (committed).

Env: NOTION_TOKEN (or kos/notion-integration-token via Secrets Manager),
     RDS_URL or KOS_DB_TUNNEL_PORT, KEVIN_OWNER_ID (optional UUID).
```

## Implementation notes

### Audit-first ordering (D-12)

`archiveSingleDb({notion, pg, db, ownerId, force, isoDate})` is exported
from `migrate-brain-dbs.mjs` so the ordering test can drive it with
mocks. The function executes:

1. `notion.databases.retrieve` — current title + archived state.
2. Idempotency check — skip if already archived + prefixed (unless `--force`).
3. Build new `[MIGRERAD-YYYY-MM-DD] <baseTitle>` (strips any existing
   migration prefix so `--force` doesn't double-stack).
4. `INSERT INTO event_log (..., kind='brain-db-archived', ..., actor='scripts/migrate-brain-dbs.mjs') RETURNING id`.
5. `notionUpdateWithRetry` → `notion.databases.update({archived: true, title: [...]})` with 3-attempt 429/5xx retry.
6. `UPDATE event_log SET detail = detail || jsonb_build_object('notion_ack_at', <iso>)` — confirmation write-back.

The audit INSERT is deliberately written immediately above the Notion
call (steps 4 + 5) so the plan's grep-based verifier
(`grep -A5 'INSERT INTO event_log' | grep notion.databases.update`)
finds the proximity guard. The textual comment block was deliberately
shrunk to keep the SQL within 5 lines of the Notion mutation.

### event_log column shape — `detail` (singular) + `occurred_at`

The plan's prose calls the JSON column `details` and the timestamp
`at`. The on-disk shape from migration `0001_initial.sql` is `detail`
(singular) + `occurred_at`, with `actor` added in `0021_phase_10_migration_audit.sql`
(per Plan 10-00 AGENT-NOTES). This script writes the on-disk names so it
matches every other Phase-10 reader/writer.

### owner_id default — Phase-1 well-known UUID

`event_log.owner_id` is `uuid NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid`
in 0001. The script uses that same UUID as its default when neither
`--owner-id` nor `KEVIN_OWNER_ID` env var is set. The plan's prose
example showed `'kevin'` as the literal string; that wouldn't pass the
DB type check. The on-disk default takes precedence.

### Idempotency

Skip rule: `archived === true` AND title regex
`/^\[MIGRERAD-\d{4}-\d{2}-\d{2}\]/` matches.

The skip path emits NO event_log row (re-runs don't double-log) and
returns `{status: 'skip'}` so the CLI summary distinguishes
`archived` vs `skipped` vs `errors`.

### --force behaviour

`--force` re-archives regardless of state. To prevent
`[MIGRERAD-2026-04-25] [MIGRERAD-2026-04-20] Brain DB X` doubles, the
helper `stripMigreratPrefix(title)` removes any existing `[MIGRERAD-DATE] `
prefix before the new one is applied. The event_log row records
`forced: true` and the `archived_before` flag in detail so the
re-archive event is distinguishable from an original.

### Notion API retry

`notionUpdateWithRetry` retries on `status` ∈ {429, 502, 503, 504} with
backoff [1s, 5s, 15s]. Override via `KOS_NOTION_RETRY_DELAYS_MS=1,1,1`
for tests. Retry logs are written to stderr so the operator sees
intermittent issues during the live run.

### Notion 90-day trash semantics (D-01)

`archived: true` puts the DB into Notion's trash; the runbook
documents that Notion retains it for 30 days (Pro) or 90 days
(Enterprise). The script never calls `notion.databases.delete` (no
such API), never empties trash, and never re-archives a row that's
already locked-in. Rollback paths: Notion UI, Notion API
`archived: false`, or read `original_title` from `event_log.detail`.

### MIG-04 invariant (Command Center untouched)

`migrate-brain-dbs.mjs` does NOT read or write the Command Center DB.
`verify-brain-dbs-archived.mjs` issues a read-only
`notion.databases.query` against the Command Center id (from
`scripts/.notion-db-ids.json#commandCenter`) and asserts `>= 167` rows
post-archive. This is informational (`[INFO] MIG-04 OK` line); a row
shortage prints `[WARN]` because the Brain DB archive script can NOT
have caused it.

### Manual operator step — Lock database (P-11)

The Notion API does NOT expose the "Lock database" toggle (per
10-RESEARCH.md §2). The script + runbook both flag this as a manual
UI step for each archived DB. The runbook checklist makes it part of
operator sign-off.

## Deviations from the plan

1. **owner_id is a UUID, not the string `'kevin'`.** The plan's prose
   `INSERT … VALUES ('kevin', ...)` would fail the DB type check
   (`event_log.owner_id` is `uuid`). Defaults to the Phase-1 well-known
   UUID `7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c`; overridable via
   `--owner-id` or `KEVIN_OWNER_ID` env.

2. **Column names are `detail` + `occurred_at`, not `details` + `at`.**
   The on-disk shape from `0001_initial.sql` (and confirmed by Plan
   10-00 AGENT-NOTES + `EventLogRowSchema` in
   `packages/contracts/src/migration.ts`) is the authoritative naming.
   The plan's prose was an early draft.

3. **Ordering test uses standard `assert` + hand-rolled mocks** instead
   of vitest. The plan's prose mentioned `vi.fn()`; running vitest on a
   `.mjs` outside a workspace is fiddly (vitest discovers via package
   `test` script). A standalone `node` invocation that anyone can run
   is more useful for an operator runbook step. The 5 assertions cover
   the same surface the plan called for (ordering, INSERT-fail-then-no-Notion,
   Notion-fail-then-no-rollback, idempotency, force).

4. **Retry backoff overridable via env var** — added
   `KOS_NOTION_RETRY_DELAYS_MS` so the failure-mode test runs in
   ~150ms. Production behaviour unchanged when env var unset.

5. **Inventory file gitignored explicitly.** `.gitignore` updated with
   `scripts/.notion-brain-dbs.json`. The example template
   (`*.example.json`) is committed.

6. **MIG-04 paged Command Center query** — the verifier pages with
   `notion.databases.query` (page_size=100) until `has_more=false` and
   sums `results.length`. This is a counted read (not a metric pulled
   from Notion); slow for very large DBs but correct for the 167-row
   target.

## What was NOT done (per plan instructions)

- No `git add`, `git commit`, `git push`.
- No real archive run — `scripts/.notion-brain-dbs.json` is intentionally
  not present (operator-deferred).
- No real Notion API call — only mock-driven tests + node --check
  syntax verification.
- No deployment of any infrastructure — Plan 10-03 is operator-runnable
  scripts only.

## Operator-deferred items

1. **Populate `scripts/.notion-brain-dbs.json`** — copy from the
   `.example.json` template and replace the 5 `REPLACE_WITH_NOTION_UUID_*`
   placeholders with real Notion DB UUIDs from Kevin's workspace.
2. **Run dry-run first** — `node scripts/migrate-brain-dbs.mjs --dry-run`.
3. **Live archive** — `node scripts/migrate-brain-dbs.mjs`.
4. **Verify** — `node scripts/verify-brain-dbs-archived.mjs`.
5. **Manual Notion UI step** — Lock database for each of the 5
   archived DBs.
6. **60-day calendar reminder** — decide un-archive vs hard-delete
   before Notion's 90-day trash window expires.

## Risks logged for downstream plans

1. **Plan 10-07 (power-down) MUST NOT run before MIG-03 verifier 5/5
   PASS.** Brain DB archival is part of the Phase-10 success criterion
   chain; powering down Hetzner before Brain DBs are archived would
   leave Phase 10 incomplete on rollback.

2. **`commandCenter` id in `scripts/.notion-db-ids.json` must remain
   stable.** If Phase-N renames or recreates Command Center, the MIG-04
   verifier check breaks silently (returns `WARN`). Cross-plan
   coordination needed.

3. **EventLogKindSchema includes `'brain-db-archived'` already** (Plan
   10-00 added it). No contracts change required by this plan.

End of agent notes.
