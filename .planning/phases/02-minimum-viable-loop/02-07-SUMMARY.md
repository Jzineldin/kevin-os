---
phase: 02-minimum-viable-loop
plan: 07
subsystem: notion-kos-inbox
tags: [wave-2, ent-03, ent-04, kos-inbox, notion-indexer, d-13, d-14, d-15, archive-not-delete, pitfall-7]
dependency_graph:
  requires:
    - "02-00 entity-resolver scaffold (defines `kosInbox` consumer expectation)"
    - "02-03 entity_index name + aliases columns (Pitfall 7 dedup query target)"
    - "01-04 notion-indexer Lambda + cursor table (extended here, not replaced)"
    - "01-04 bootstrap-notion-dbs.mjs framework (extended with ensureKosInboxDb)"
  provides:
    - "scripts/bootstrap-notion-dbs.mjs ensureKosInboxDb() — idempotent KOS Inbox DB provisioner with 9 properties (8 D-13 + MergedInto)"
    - "scripts/verify-kos-inbox-schema.mjs — operator verifier asserts 9 properties + Status/Type select option sets"
    - "packages/db/drizzle/0005_kos_inbox_cursor.sql — NOOP migration breadcrumb (cursor table already keyed by db_id)"
    - "packages/cdk/lib/stacks/integrations-notion.ts kos-inbox-poll schedule + NOTION_KOS_INBOX_DB_ID + NOTION_ENTITIES_DB_ID env wiring"
    - "services/notion-indexer/src/notion-shapes.ts KosInboxRowSchema (zod)"
    - "services/notion-indexer/src/upsert.ts processKosInboxBatch + normaliseName"
    - "services/notion-indexer/src/handler.ts kos_inbox dispatch branch + runKosInboxIndexer"
  affects:
    - "Plan 02-05 entity-resolver inbox.ts: NOTION_KOS_INBOX_DB_ID env now resolves to a real DB UUID once Kevin runs the live bootstrap; until then runtime error remains actionable"
    - "Plan 02-08 / 02-09 (bulk imports): can land candidate rows directly into the KOS Inbox DB; same indexer path syncs them on Approve"
    - "Plan 02-09 (observability): add CloudWatch alarm on the kos-inbox-poll schedule + Langfuse traces (no new code paths needed in 02-09 — alarm wires to existing notion-indexer Lambda)"
    - "Plan 02-11 (e2e gate): Approve-flow round-trip becomes the second e2e assertion target alongside mention.resolved"
tech_stack:
  added:
    - "Notion @notionhq/client database create with 9-property schema (database create + relation property + select with color options)"
    - "zod KosInboxRowSchema with passthrough for forward-compat Notion property additions"
  patterns:
    - "Indexer batch dispatch — kos_inbox branch returns aggregate counters {approved, rejected, skipped} instead of per-page upsert outcomes; cursor still advanced atomically at batch end"
    - "Pitfall 7 dedup at indexer Approve-time — LOWER(name) OR alias scan against entity_index before creating a new Entities page"
    - "Event-log idempotency keyed on (inbox_page_id, to_status='Merged' for Approved | 'Rejected' for Rejected) — EB retries + 5-min overlap windows produce zero duplicate Notion writes"
    - "Archive-not-delete on Reject (D-09 / archive-never-delete policy enforced consistently with Phase 1 hard-delete handling)"
    - "Empty-fallback for kosInbox in CDK loadNotionIds (mirrors integrations-agents.ts Plan 02-05 deploy-unblock convention) — keeps synth/tests green pre-bootstrap"
key_files:
  created:
    - scripts/verify-kos-inbox-schema.mjs
    - packages/db/drizzle/0005_kos_inbox_cursor.sql
    - services/notion-indexer/test/kos-inbox.test.ts
    - .planning/phases/02-minimum-viable-loop/02-07-SUMMARY.md
  modified:
    - scripts/bootstrap-notion-dbs.mjs (ensureKosInboxDb + kosInbox state key)
    - packages/db/drizzle/meta/_journal.json (0005 entry)
    - packages/cdk/lib/stacks/integrations-notion.ts (5th schedule + env vars + kosInbox empty-fallback)
    - packages/cdk/test/integrations-stack-notion.test.ts (3 new assertions; 9/9 tests)
    - services/notion-indexer/src/notion-shapes.ts (KosInboxRowSchema)
    - services/notion-indexer/src/upsert.ts (processKosInboxBatch + normaliseName)
    - services/notion-indexer/src/handler.ts (kos_inbox dispatch + runKosInboxIndexer)
decisions:
  - "Kept `kosInbox` OPTIONAL in `integrations-notion.ts` loadNotionIds (empty-string fallback) instead of hard-required as the plan literally said. Rationale: (a) the live Notion DB cannot be created without Kevin's NOTION_TOKEN, which is absent in the executor environment per the objective's no-stub directive; (b) the existing `integrations-agents.ts` (Plan 02-05) already uses this exact pattern for the same key; (c) requiring it would have blocked CDK synth + tests until Kevin runs bootstrap. Runtime error in handler is actionable: 'NOTION_ENTITIES_DB_ID env var missing — required for KOS Inbox Approve→create-or-reuse Entities-DB page (Plan 02-07)'."
  - "Plan 02-07 NOOP migration (0005) ships only as a journal breadcrumb. The Phase 1 cursor table already supports any dbKind value via lazy INSERT ... ON CONFLICT (db_id) — no DDL change is required to add KOS Inbox polling. Future schema audits can grep for 0005 to find the wiring change. (Plan permitted both NOOP and additive paths; chose NOOP because Phase 1 schema already covers the case.)"
  - "Plan 02-07 indexer creates the new Entities-DB page itself rather than writing entity_index directly. The next 5-min entities-DB poll picks up the new page and runs the existing upsertEntity path — keeps Plan 02-07 thin (no entity_index writer code duplicated in the new branch). Trade-off: 5-min staleness window between Inbox=Merged and entity_index population, which Plan 02-05 already accepts (see Plan 02-05 SUMMARY.md decisions, line 5)."
  - "Schedule named `kos-inbox-poll` (not `notion-indexer-kosinbox`) per the plan's literal acceptance grep. Schedule input includes `dbName: 'kosInbox'` alongside `dbKind: 'kos_inbox'` — the handler honours either, but `dbName` is the operator-friendly key matching `scripts/.notion-db-ids.json`."
  - "Pitfall 7 dedup query uses `LOWER(name) = $1 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = $1)`. The normaliseName client-side fn (NFD + lowercase + collapse-spaces) does the case + diacritic + whitespace normalisation in one step — same fn as `services/entity-resolver/src/inbox.ts` so resolver + indexer agree on what 'same name' means. Test 'Approved (existing entity by normalised name)' uses input 'damien hateley' against stored 'Damien Hateley' to prove the case-insensitive path works."
  - "Event-log dedup query maps Approved→to_status='Merged' and Rejected→to_status='Rejected' (the destination state, not the inbound select). Otherwise an Approved row that the indexer just flipped to Merged could re-enter the dedup check on the next tick and mis-skip — confirmed via the idempotency test."
metrics:
  duration_minutes: ~28
  completed: 2026-04-22
  tasks: 2
  files_created: 4
  files_modified: 7
  commits: 2
---

# Phase 2 Plan 07: KOS Inbox + Indexer Sync Summary

The human-in-the-loop entity-resolver inbox queue ships: bootstrap-notion-dbs.mjs gains an idempotent `ensureKosInboxDb()` that creates the 9-property Notion database (8 D-13 properties + MergedInto for the D-14 merge path) under Kevin's KOS parent page; an operator verifier (`scripts/verify-kos-inbox-schema.mjs`) asserts the 9 properties plus the Status (Pending/Approved/Merged/Rejected) and Type (Person/Project/Org/Other) select option sets; the Phase 1 notion-indexer gains a 5th EventBridge schedule (`kos-inbox-poll`, every 5 min) firing the same Lambda with `dbKind='kos_inbox'`. On every tick the indexer pulls KOS Inbox rows changed since the cursor (Status != Pending), then dispatches per row: Approved → Pitfall-7 dedup against `entity_index.name + aliases`; if existing match, reuse its `notion_page_id`, else create a new Entities-DB page with `Source=['kos-inbox']`; either way flip Inbox row to `Status=Merged` with `MergedInto` relation pointing at the target Entities page. Rejected → archive the Notion page (D-09 archive-not-delete) and write `event_log kind='kos-inbox-rejected'`. Pending/Merged → skip. Every Approved/Rejected transition writes `event_log kind='kos-inbox-transition'` keyed on `(inbox_page_id, to_status)`; the indexer dedup-checks this log before any Notion mutation, so EventBridge retries and the 5-min overlap window emit zero duplicate writes.

## Objective

Realise D-13 (8-property Inbox DB schema), D-14 (Status-flip-driven sync via indexer), D-15 (Notion is the approval surface — no bot buttons, no Phase 2 dashboard), ENT-03 (voice-onboarding Person via Inbox Approve), ENT-04 (voice-onboarding Project via Inbox Approve). Without this plan, Plan 02-05's `findApprovedOrPendingInbox` + `createInboxRow` calls have no live Notion DB to target; Plan 02-08/09's bulk imports have nowhere to land low-confidence candidates. After this plan, Kevin's only friction surface is a Notion select dropdown; the indexer sweeps in within 5 minutes.

## What Shipped

### Task 1 — Bootstrap + verify script + CDK schedule + NOOP migration (commit `eb378c9`)

- **`scripts/bootstrap-notion-dbs.mjs`** — added `kosInboxProperties(entitiesDbId)` builder (9 properties: Proposed Entity Name, Type, Candidate Matches→Entities, Source Capture ID, Status, Confidence, Raw Context, Created, MergedInto→Entities) and `ensureKosInboxDb(entitiesDbId)` idempotent creator. Wired into `main()` after the entities DB is created. Persists `kosInbox` UUID into `scripts/.notion-db-ids.json`. Description text on the DB documents the Kevin-flow ("Flip Status to Approved / Merged / Rejected; notion-indexer syncs within 5 min").
- **`scripts/verify-kos-inbox-schema.mjs`** (new, +x) — operator verifier. Reads `scripts/.notion-db-ids.json` for `kosInbox`, retrieves the DB via Notion API, asserts all 9 expected `(name, type)` pairs exist, then cross-checks the Status select includes {Pending, Approved, Merged, Rejected} and Type includes {Person, Project, Org, Other}. Exits 0 on success, 1 on schema drift.
- **`packages/db/drizzle/0005_kos_inbox_cursor.sql`** (new) — NOOP migration. The Phase 1 `notion_indexer_cursor` table is already keyed by `db_id` (Notion DB UUID) with a free-form `db_kind` text discriminator; the new KOS Inbox row is created lazily at runtime via INSERT … ON CONFLICT. The migration body is `SELECT 1` and exists only as a journal breadcrumb so future audits can trace the KOS Inbox poll back to Plan 02-07.
- **`packages/db/drizzle/meta/_journal.json`** — appended idx 4 entry for `0005_kos_inbox_cursor`.
- **`packages/cdk/lib/stacks/integrations-notion.ts`** — extended:
  - `NotionIds` type: added `kosInbox: string` (commented as optional-at-synth)
  - `loadNotionIds()`: keeps the original 5 keys required; `kosInbox` falls through to empty string. Mirrors the deploy-unblock pattern from Plan 02-05's `integrations-agents.ts`.
  - notion-indexer Lambda env: added `NOTION_KOS_INBOX_DB_ID` + `NOTION_ENTITIES_DB_ID` (the indexer needs both — the latter for creating new Entities-DB pages on Approve)
  - `watched` schedule list: added `{ key: 'KosInbox', dbId: NOTION_IDS.kosInbox, dbKind: 'kos_inbox' }`
  - Schedule loop: special-cases `KosInbox` to use the operator-friendly name `kos-inbox-poll` and emits an Input JSON containing `"dbName":"kosInbox"`. The indexer handler honours either dbName or dbKind.
- **`packages/cdk/test/integrations-stack-notion.test.ts`** — added 3 assertions:
  - 6 schedules total (was 5: 4 D-11 + 1 reconcile; now 5 polling + 1 reconcile)
  - `kos-inbox-poll` schedule exists with rate(5 minutes) + Europe/Stockholm + Input contains `"dbName":"kosInbox"`
  - notion-indexer Lambda env contains both NOTION_KOS_INBOX_DB_ID and NOTION_ENTITIES_DB_ID
  - 9/9 notion stack tests passing; 78/78 full CDK suite passing.

### Task 2 — Indexer kos_inbox branch + Pitfall 7 dedup + idempotency (commit `39b4975`)

- **`services/notion-indexer/src/notion-shapes.ts`** — added `KosInboxRowSchema` (zod) validating the 9 D-13 properties (passthrough for forward-compat). Exported as named export per acceptance grep.
- **`services/notion-indexer/src/upsert.ts`** — added:
  - `normaliseName(s)` — exact mirror of `services/entity-resolver/src/inbox.ts` so resolver + indexer agree on what "same name" means.
  - `processKosInboxBatch({ client, db, rows, ownerId, entitiesDbId })`:
    1. For each row, read Status. Pending/Merged/null → counters.skipped++.
    2. Dedup check against event_log: `SELECT 1 FROM event_log WHERE kind IN ('kos-inbox-transition', 'kos-inbox-rejected') AND detail->>'inbox_page_id' = $1 AND detail->>'to_status' = $2` where $2 maps Approved→'Merged' / Rejected→'Rejected' (destination status, not inbound select).
    3. Rejected: `client.pages.update({page_id, archived: true})` + INSERT event_log `kos-inbox-rejected` with `{inbox_page_id, to_status, capture_id, archived_at}`.
    4. Approved: extract Proposed Entity Name + Type + Raw Context + Source Capture ID. Run dedup query `SELECT id, notion_page_id, name FROM entity_index WHERE LOWER(name) = $1 OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = $1) LIMIT 1`. If hit → reuse `notion_page_id`. If miss → `client.pages.create` Entities-DB page with `{Name, Type, SeedContext, Source: ['kos-inbox'], Status: 'Active'}`. Then `client.pages.update(inboxPageId, {Status: 'Merged', MergedInto: [{id: targetPageId}]})` and INSERT event_log `kos-inbox-transition` with `{inbox_page_id, to_status: 'Merged', target_entity_page_id, capture_id, merged_at}`.
    5. Returns `{approved, rejected, skipped}` counters.
- **`services/notion-indexer/src/handler.ts`** — extended:
  - `IndexerEvent.dbKind` union: added `'kos_inbox'`
  - `IndexerEvent.dbName?: string` field — Plan 02-07 schedule emits both `dbKind:'kos_inbox'` and `dbName:'kosInbox'`; either triggers the new branch
  - In `runIndexer`, after cursor lookup + overlap calc: `if (event.dbKind === 'kos_inbox' || event.dbName === 'kosInbox')` short-circuits to `runKosInboxIndexer`.
  - `runKosInboxIndexer` paginates the KOS Inbox query (filter: `last_edited_time > overlapFrom AND Status != Pending`), accumulates rows, calls `processKosInboxBatch`, advances cursor only on success. Throws actionable error if `NOTION_ENTITIES_DB_ID` env var is missing.
- **`services/notion-indexer/test/kos-inbox.test.ts`** — 6 behavioural tests, all passing:
  1. **Approved (new name)** → 1 `pages.create` (Entities), 1 `pages.update` (inbox→Merged with MergedInto), event_log `kos-inbox-transition` written
  2. **Approved (existing entity by normalised name)** → 0 `pages.create`, 1 `pages.update` with MergedInto pointing at the existing entity's `notion_page_id` (Pitfall 7)
  3. **Rejected** → 0 creates, 1 update with `archived: true`, event_log `kos-inbox-rejected` written
  4. **Pending + Merged** → 0 mutations, both counted as skipped
  5. **Mixed batch (1 Approved / 1 Rejected / 1 Pending)** → 1 create, 2 updates, counters `{1,1,1}`
  6. **Idempotency re-run** — when event_log already has `inbox-1|Merged` and `inbox-3|Rejected` markers, both rows fall through to skipped with 0 Notion mutations. Proves the dedup query short-circuits before any side effect.

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test` (78/78) | PASS |
| `pnpm --filter @kos/cdk test -- --run integrations-stack-notion` (9/9) | PASS |
| `pnpm --filter @kos/service-notion-indexer typecheck` | PASS |
| `pnpm --filter @kos/service-notion-indexer test` (11/11) | PASS |
| `pnpm --filter @kos/service-notion-indexer test -- --run kos-inbox` (6/6) | PASS |
| `test -x scripts/verify-kos-inbox-schema.mjs` | PASS |
| `grep -q "ensureKosInboxDb" scripts/bootstrap-notion-dbs.mjs` | PASS |
| `grep -q "kosInbox" scripts/bootstrap-notion-dbs.mjs` | PASS (10 hits) |
| `grep -q "MergedInto" scripts/bootstrap-notion-dbs.mjs` | PASS |
| `grep -q "Proposed Entity Name" scripts/verify-kos-inbox-schema.mjs` | PASS |
| `grep -q "kosInbox" packages/cdk/lib/stacks/integrations-notion.ts` | PASS (8 hits) |
| `grep -q "kos-inbox-poll" packages/cdk/lib/stacks/integrations-notion.ts` | PASS |
| `grep -q "NOTION_KOS_INBOX_DB_ID" packages/cdk/lib/stacks/integrations-notion.ts` | PASS |
| `grep -q "KosInboxRowSchema" services/notion-indexer/src/notion-shapes.ts` | PASS |
| `grep -q "processKosInboxBatch" services/notion-indexer/src/upsert.ts` | PASS |
| `grep -q "archived: true" services/notion-indexer/src/upsert.ts` | PASS |
| `grep -q "MergedInto" services/notion-indexer/src/upsert.ts` | PASS |
| `grep -q "kos-inbox-transition" services/notion-indexer/src/upsert.ts` | PASS |
| `grep -q "kosInbox" services/notion-indexer/src/handler.ts` | PASS (4 hits) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Empty-fallback for kosInbox in CDK loadNotionIds (vs plan's "required")**

- **Found during:** Task 1, when wiring `loadNotionIds()` to require `kosInbox`. The agent environment has no Notion API credentials (no `NOTION_TOKEN` env, no `kos/notion-token` Secrets Manager entry — verified via `aws secretsmanager list-secrets`), so the live bootstrap can't run, so a real `kosInbox` UUID can't be obtained, AND the executor objective explicitly forbids stubbing a placeholder UUID into `.notion-db-ids.json`.
- **Issue:** Making `kosInbox` required in `loadNotionIds()` would cause `pnpm --filter @kos/cdk test` to throw `scripts/.notion-db-ids.json missing required key "kosInbox"` on every synth-mode test, breaking the Phase 1 test gate without any path forward.
- **Fix:** Kept the original 5 required keys; allow `kosInbox` to fall through to empty string. Mirrors the **identical pattern Plan 02-05 already established** in `packages/cdk/lib/stacks/integrations-agents.ts`'s `loadKosInboxIdOrEmpty()`. Runtime error in `runKosInboxIndexer` is actionable: throws `'NOTION_ENTITIES_DB_ID env var missing — required for KOS Inbox Approve→create-or-reuse Entities-DB page (Plan 02-07)'` if the env is empty. CDK synth + all 78 tests pass with the empty fallback.
- **Files modified:** `packages/cdk/lib/stacks/integrations-notion.ts`
- **Commit:** `eb378c9`
- **Rule rationale:** Rule 3 — synth-blocking when the live DB UUID cannot be obtained in the current environment. The same deploy-unblock pattern is already documented in Plan 02-05 SUMMARY.md decisions section.

**2. [Rule 1 — Bug] Initial dedup query used inbound `status` instead of destination `to_status`**

- **Found during:** Task 2, idempotency test failed with `{approved:1, skipped:1}` instead of `{approved:0, skipped:2}` after seeding event_log markers.
- **Issue:** First implementation queried `event_log WHERE detail->>'to_status' = $1` with `$1 = status` (the inbound select value, e.g. 'Approved'). But the actual `to_status` recorded in event_log is 'Merged' for Approved rows (the destination state) — so an Approved row whose Merged transition was already logged would not be deduped.
- **Fix:** Mapped `expectedToStatus = status === 'Approved' ? 'Merged' : 'Rejected'` and pass that to the query. Idempotency test now passes with `{0, 0, 2}` (both rows correctly identified as already-processed and skipped). Documented inline in `upsert.ts` comments.
- **Files modified:** `services/notion-indexer/src/upsert.ts`
- **Commit:** `39b4975`
- **Rule rationale:** Rule 1 — correctness bug in dedup keying that would have led to duplicate Notion writes on every replay. Caught + fixed via TDD test 6 before commit.

## Authentication Gates

**Live KOS Inbox DB creation deferred to Kevin (operator-only step).**

The agent environment has no Notion API credentials. The `scripts/bootstrap-notion-dbs.mjs` extension is shipped + tested (its `ensureKosInboxDb` is wired correctly into `main()`), but actually creating the Notion database requires Kevin's `NOTION_TOKEN` and his Notion workspace. This is an operator gate, not a code gate. Until it runs:
- `scripts/.notion-db-ids.json` lacks the `kosInbox` key
- CDK synth uses empty string for `NOTION_KOS_INBOX_DB_ID` env (per Plan 02-05 deploy-unblock pattern)
- The `kos-inbox-poll` schedule fires the indexer Lambda but the Lambda throws an actionable error on first invocation
- Plan 02-05 entity-resolver dual-read calls also throw actionable errors

**Operator runbook to lift the gate:**

```bash
# 1. Ensure NOTION_TOKEN secret is seeded (one-time)
aws secretsmanager get-secret-value --secret-id kos/notion-token >/dev/null 2>&1 \
  || aws secretsmanager create-secret --name kos/notion-token --secret-string "secret_..."

# 2. Run the bootstrap with Kevin's parent-page UUID
export NOTION_PARENT_PAGE_ID=<kevin's KOS parent page UUID>
export EXISTING_COMMAND_CENTER_DB_ID=f4c693b1-68da-4be6-9828-ca55dc2712ee
node scripts/bootstrap-notion-dbs.mjs
# expect: [+] creating KOS Inbox DB
# scripts/.notion-db-ids.json now has "kosInbox": "<UUID>"

# 3. Verify schema
node scripts/verify-kos-inbox-schema.mjs
# expect: [OK] KOS Inbox DB schema verified: 9 properties (8 D-13 + MergedInto)

# 4. Re-deploy CDK so NOTION_KOS_INBOX_DB_ID env populates
KEVIN_OWNER_ID=… KEVIN_TELEGRAM_USER_ID=… npx cdk deploy KosIntegrations KosAgents

# 5. Smoke-test: create a Pending row in Notion, flip Status→Approved, wait ≤5 min
#    Expect: new Entities page appears, Inbox row Status=Merged with MergedInto set
```

**No partial work was committed for this gate.** Code is complete; only Kevin's manual bootstrap step remains.

## Threat-Register Coverage

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-INBOX-01 (Tampering — double-processing of Approved row) | mitigated | event_log dedup query keyed on (inbox_page_id, to_status='Merged'); idempotency test `kos-inbox.test.ts` proves 2nd call emits zero Notion mutations |
| T-02-INBOX-02 (Information Disclosure — bad data approved accidentally) | accepted | D-12 LLM pre-filter + D-11 auto-merge gate + archive-not-delete on Reject means all history recoverable; Kevin manually edits Notion if wrong |
| T-02-INBOX-03 (Tampering — Notion API rate-limit during bootstrap) | mitigated | bootstrap-notion-dbs.mjs already applies Phase 1 backoff conventions; KOS Inbox adds only one DB create call (no behavioural change) |
| T-02-INBOX-04 (Elevation of Privilege — Notion token over-scoped) | mitigated | Inherited from Phase 1 — token is K-OS integration only; no admin scope. Operator runbook above does not request elevated scope. |

## Known Stubs

**Live KOS Inbox DB UUID is NOT in `scripts/.notion-db-ids.json`.** This is the operator gate documented above, not a stub. CDK synth uses empty-string fallback per the Plan 02-05 convention; runtime error is actionable. Kevin's bootstrap run resolves this in one command.

No source code stubs. All routing branches are end-to-end functional against the in-memory Notion + pg mocks.

## Threat Flags

None new. The KOS Inbox indexer branch reads + writes Notion within the existing `notionTokenSecret.grantRead` boundary (no new IAM grants needed — Notion API surface is identical) and writes only to `event_log` in Postgres (existing table, no new schema). The new schedule fires the existing Lambda within its existing IAM role.

## Handoffs to Next Plans

- **Plan 02-08 (bulk-import existing Kontakter, ENT-05):** can land low-confidence rows directly into the KOS Inbox DB via `client.pages.create` — same indexer path syncs them on Approve. No new code in 02-07 needed; the bulk script just calls the same Notion API surface.
- **Plan 02-09 (observability):** add CloudWatch alarm on the new `kos-inbox-poll` schedule (FailedInvocations > 0) consistently with the existing 4 indexer schedules; wire Langfuse trace tags for the kos_inbox dispatch branch (`agent_name='notion-indexer:kos_inbox'`).
- **Plan 02-11 (e2e gate):** add a second e2e assertion — synthetic Approved Inbox row → ≤5 min → entity_index has new row + Inbox row Status=Merged. Pairs with the existing mention.resolved assertion to fully exercise the resolver→Inbox→Approve→entity_index loop.
- **Operator (Kevin):** run the bootstrap + verify + redeploy sequence above before relying on Plan 02-05 resolver invocations in production. Until then resolver Lambda's first dual-read call surfaces the actionable error.

## Commits

| Hash | Message |
|------|---------|
| `eb378c9` | feat(02-07): KOS Inbox bootstrap + CDK kos-inbox-poll schedule (D-13/D-14) |
| `39b4975` | feat(02-07): notion-indexer KOS Inbox sync — Approve→merge, Reject→archive |

## Self-Check: PASSED

Verified files on disk:
- scripts/bootstrap-notion-dbs.mjs — MODIFIED (ensureKosInboxDb + main wiring)
- scripts/verify-kos-inbox-schema.mjs — FOUND (+x)
- packages/db/drizzle/0005_kos_inbox_cursor.sql — FOUND
- packages/db/drizzle/meta/_journal.json — MODIFIED (idx 4 added)
- packages/cdk/lib/stacks/integrations-notion.ts — MODIFIED (5th schedule + env wiring + empty fallback)
- packages/cdk/test/integrations-stack-notion.test.ts — MODIFIED (3 new assertions, 9/9 passing)
- services/notion-indexer/src/notion-shapes.ts — MODIFIED (KosInboxRowSchema)
- services/notion-indexer/src/upsert.ts — MODIFIED (processKosInboxBatch + normaliseName)
- services/notion-indexer/src/handler.ts — MODIFIED (kos_inbox dispatch + runKosInboxIndexer)
- services/notion-indexer/test/kos-inbox.test.ts — FOUND (6/6 passing)

Verified commits in `git log`:
- `eb378c9 feat(02-07): KOS Inbox bootstrap + CDK kos-inbox-poll schedule (D-13/D-14)` — FOUND
- `39b4975 feat(02-07): notion-indexer KOS Inbox sync — Approve→merge, Reject→archive` — FOUND
