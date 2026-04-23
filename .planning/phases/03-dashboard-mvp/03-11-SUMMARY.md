---
phase: 03-dashboard-mvp
plan: 11
subsystem: dashboard-merge
tags: [merge, entity-merge-audit, state-machine, archive-never-delete, resume, revert, cancel, ui-3-5]
requirements: [ENT-07]
requirements_addressed: [ENT-07]

dependency_graph:
  requires:
    - 03-01 (migration 0007 entity_merge_audit + 0008 inbox_index)
    - 03-02 (dashboard-api router + callApi + Notion/Events/DB seams; merge route stubs)
    - 03-05 (callApi SigV4 + kos_session gate)
    - 03-09 (ResumeMergeCard + /api/merge-resume passthrough + inbox focus=resume- deep link)
    - 03-10 (entity dossier + StatsRail "Merge duplicates" link)
  provides:
    - POST /entities/:target_id/merge (4-step transactional state machine)
    - POST /entities/:target_id/merge/resume?action=resume|cancel|revert
    - services/dashboard-api/src/handlers/notion-merge.ts (archive-only Notion helpers)
    - /entities/[id]/merge review page (RSC) + MergeReview client + MergeConfirmDialog
    - Server Actions: executeMerge, resumeMergeAction
    - /api/merge-resume parameterised with target_id + action query params
    - ResumeMergeCard Revert + Cancel routed to real endpoint (replaces Plan 09 toast stubs)
    - merge-review.test.tsx (5 unit cases) + merge-audit.spec.ts (2 E2E cases, preview-gated)
    - 11 new dashboard-api tests (transactional 3 + partial 1 + resume 7) — Plan 00 todos retired
  affects:
    - 03-12 (PWA + Lighthouse) — will measure /entities/[id]/merge against the < 500 ms budget
    - Phase 6 agent-side merges — reuses the same state machine + merge_id ULID PK;
      agent path writes initiated_by='agent:entity-resolver' instead of 'kevin'

tech_stack:
  added:
    - ulid@2.3.0 on @kos/dashboard (Server Action + Dialog both generate merge_id client-side so the replay-safe PK is set before the request leaves the browser)
  patterns:
    - 4-step state machine: initiated -> notion_relations_copied -> notion_archived -> rds_updated -> complete;
      failure at step N -> failed_at_<lastOk>. Resume picks up from lastOk without re-running completed steps.
    - ARCHIVE-NEVER-DELETE comment present on both merge.ts and notion-merge.ts; negative grep `! grep "pages.delete" services/dashboard-api/src/handlers/*.ts` passes.
    - Idempotent resume via `isPastOrEqual(lastOk, target)` guards on each step.
    - Notion P-06 rate limit: 400ms inter-call sleep inserted between step 1 (copy relations) and step 2 (archive).
    - Partial failure surfaces via inbox_index INSERT (kind='merge_resume'); Plan 09's ResumeMergeCard already subscribes to that kind and renders the card on next router.refresh() after the SSE entity_merge event.
    - Server Action redirect-on-failure to /inbox?focus=resume-<merge_id> per Plan 09 handoff item #4.
    - /api/merge-resume now forwards target_id via URL segment (Plan 09 handoff item #2) + action= query param.

key_files:
  created:
    - services/dashboard-api/src/handlers/notion-merge.ts
    - "apps/dashboard/src/app/(app)/entities/[id]/merge/page.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/merge/MergeReview.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/merge/MergeConfirmDialog.tsx"
    - "apps/dashboard/src/app/(app)/entities/[id]/merge/actions.ts"
    - apps/dashboard/tests/unit/merge-review.test.tsx
  modified:
    - services/dashboard-api/src/handlers/merge.ts (501 stubs -> full 4-step state machine)
    - services/dashboard-api/tests/merge-transactional.test.ts (todo -> 3 real cases)
    - services/dashboard-api/tests/merge-partial.test.ts (todo -> 1 real case)
    - services/dashboard-api/tests/merge-resume.test.ts (todo -> 7 real cases)
    - "apps/dashboard/src/app/(app)/inbox/ResumeMergeCard.tsx (Revert + Cancel wired to real endpoint)"
    - apps/dashboard/src/app/api/merge-resume/route.ts (parameterised target_id + action)
    - apps/dashboard/tests/unit/resume-merge-card.test.tsx (stubs -> real endpoint assertions)
    - apps/dashboard/tests/e2e/merge-audit.spec.ts (fixme -> active, preview-gated)
    - apps/dashboard/package.json (+ ulid)
    - pnpm-lock.yaml

decisions:
  - "merge_id is generated CLIENT-SIDE in MergeConfirmDialog (Task 2), not server-side. Rationale: the Server Action can use the same merge_id for its fallback redirect to /inbox?focus=resume-<merge_id> even when the dashboard-api call fails before the audit row is written. This also means one ULID per dialog open — if Kevin cancels and re-opens, he gets a fresh merge_id, and the handler rejects the stale one with 409 (T-3-11-01) if he somehow fires the stale request."
  - "Phase 3 copyRelations walks the source page's entire relation-typed property set (rather than hard-coding LinkedProjects as the plan's first draft suggested). Rationale: Notion's page-retrieve returns all relation properties in a single call — the extra cost over hard-coding one property name is zero, and it makes the merge robust to any future Notion schema change on the Entities DB."
  - "Per-field radio toggle in the diff panel is documented in UI-SPEC §View 3.5 but NOT implemented in Phase 3. Rationale: the dashboard-api merge handler doesn't yet accept a field-override map; adding it is a contract extension. Phase 3 keeps target's value on every field (the canonical entity wins), which matches Kevin's 'merge Maria into Maria Lindqvist' mental model."
  - "Revert flow un-archives Notion + reverse-FK on RDS but does NOT reverse the agent_runs audit row. Rationale: agent_runs is an append-only audit log by design (Plan 1 contract); reverting a merge writes a NEW state='reverted' row on entity_merge_audit, and agent_runs retains the original 'entity_merge_manual' success event. The audit trail preserves the sequence: merge completed -> user reverted 2 minutes later."
  - "Archive-never-delete comment intentionally uses the phrase 'Notion page-deletion API' instead of the literal `pages.delete` string. Rationale: the grep assertion `! grep \"pages.delete\" services/dashboard-api/src/handlers/merge.ts` would false-positive on a comment containing the banned phrase. Phrasing it without the literal keeps the grep pure-negative."
  - "tests/merge-resume.test.ts uses `import * as notionMerge` + casts for the spy pattern instead of capturing `vi.fn()` in an outer const (vitest mock factories are hoisted — outer const declarations hit TDZ). Verified via the 7/7 green run."
  - "/api/merge-resume is kept as a Node-runtime Route Handler (rather than converting to a Server Action). Rationale: ResumeMergeCard lives inside a client component's click handler; a fetch to a Node-runtime route is the simplest surface. Also, Kevin may later want to trigger Resume from a notification — the Route Handler is uniformly addressable (Server Actions require the origin-tied dispatcher)."
  - "Calling dashboard-api via placeholder target segment `/entities/-/merge/resume` is deliberate: the resume handler looks up source/target from the audit row keyed by merge_id, so the URL segment is informational only. The Plan 09 handoff item #2 called for full parameterisation — /api/merge-resume now forwards target_id when a valid UUID is present, falling back to `-` only when no target_id query is supplied (which is the case for inbox-side Resume clicks where target_id isn't part of the inbox row schema)."

metrics:
  duration: 00:30
  tasks: 2
  files_created: 6
  files_modified: 10
  tests_added: 17  # 11 dashboard-api (3 tx + 1 partial + 7 resume) + 5 merge-review + 1 net resume-card (6 vs prior 5)
  tests_passing_dashboard_api: 57  # was 46 before this plan
  tests_passing_dashboard: 91  # was 85 before this plan
  build: clean
  route_sizes:
    "/entities/[id]/merge": "4.27 kB (202 kB first-load)"
  commits:
    - ae537d1 feat(03-11) merge state machine + transactional handler
    - dc3a9d7 feat(03-11) merge review page + MergeConfirmDialog + ResumeMergeCard action wiring
  completed: 2026-04-23T12:23:00Z
---

# Phase 3 Plan 11: Merge Review (ENT-07) Summary

Plan 11 ships the full transactional entity-merge flow: the 4-step state-machine handler on dashboard-api (replacing Plan 02's 501 stubs), a dedicated `/entities/[id]/merge` review page with two-column diff + UI-SPEC-verbatim confirm Dialog, and the real Resume / Revert / Cancel wiring through /api/merge-resume. Archive-never-delete (STATE.md #12) is enforced in code + test. The Plan 09 ResumeMergeCard stubs are retired — Revert and Cancel now hit the real dashboard-api resume handler.

## One-liner

ENT-07 lands: `POST /entities/:target/merge` runs `initiated -> notion_relations_copied -> notion_archived -> rds_updated -> complete` with partial-failure recovery via inbox_index merge_resume rows; `/entities/[id]/merge` renders the two-column review + shadcn Dialog with UI-SPEC verbatim copy (`archived, not deleted` / `Yes, merge`); Revert and Cancel actions on ResumeMergeCard now POST to the real backend.

## State machine (binding)

```
                 +------------------+
                 |    initiated     |  <-- INSERT entity_merge_audit (merge_id PK, T-3-11-01 replay guard)
                 +--------+---------+
                          |
                     step 1 copyRelations(notion, src, tgt) + 400ms sleep (P-06)
                          |
                 +--------v---------+
                 | notion_relations_|
                 |    copied        |
                 +--------+---------+
                          |
                     step 2 archiveNotionPage(notion, src) -- pages.update({archived:true}) ONLY
                          |
                 +--------v---------+
                 | notion_archived  |  <-- notion_archived_at timestamp set
                 +--------+---------+
                          |
                     step 3 RDS txn: mention_events -> target; entity_index.status='merged_into'
                          |
                 +--------v---------+
                 |  rds_updated     |  <-- rds_updated_at timestamp set
                 +--------+---------+
                          |
                     step 4 INSERT agent_runs (agent_name='entity_merge_manual'); publishOutput('entity_merge')
                          |
                 +--------v---------+
                 |    complete      |  <-- completed_at set; terminal success
                 +------------------+

On any step throw: UPDATE state='failed_at_<lastOk>' + INSERT inbox_index row kind='merge_resume'
                   -> Plan 09 ResumeMergeCard surfaces next router.refresh() tick

Resume semantics (POST .../merge/resume):
  default action=resume -> runMergeSteps(startFrom = normaliseState(row.state))
                           isPastOrEqual() skips completed steps
  action=cancel          -> UPDATE state='cancelled'
  action=revert          -> unarchiveNotionPage + reverse RDS txn + UPDATE state='reverted'
```

## Archive-never-delete enforcement (STATE.md #12)

```bash
# Negative grep MUST be empty:
grep "pages.delete" services/dashboard-api/src/handlers/merge.ts   # -> (no output, exit 1)
grep "pages.delete" services/dashboard-api/src/handlers/notion-merge.ts  # -> (no output, exit 1)

# Positive grep MUST hit:
grep -c "archived: true" services/dashboard-api/src/handlers/notion-merge.ts  # -> 5
grep -c "ARCHIVE-NEVER-DELETE" services/dashboard-api/src/handlers/*.ts       # -> 3 (1 in merge.ts, 2 in notion-merge.ts)
```

Both helpers (`archiveNotionPage` + `unarchiveNotionPage` for the revert path) use `notion.pages.update({ archived: boolean })`. Nothing in the handler chain references the Notion deletion API.

## UI-SPEC copy verification (binding, UI-SPEC lines 543-547)

| Element | Copy (verbatim) | Location | Status |
|---------|-----------------|----------|--------|
| Page primary button | `Confirm merge` | MergeReview.tsx | confirmed |
| Dialog headline | `Merge {source.name} into {target.name}?` | MergeConfirmDialog.tsx | confirmed |
| Dialog body | `The source entity will be archived, not deleted. All mentions, tasks, and projects will be re-pointed to {target.name}. This is logged to the audit table. You can revert this within 7 days from the Inbox Resume card.` | MergeConfirmDialog.tsx | confirmed |
| Dialog primary | `Yes, merge` | MergeConfirmDialog.tsx | confirmed |
| Dialog secondary | `Cancel` | MergeConfirmDialog.tsx | confirmed |
| Source card eyebrow | `ARCHIVING` | MergeReview.tsx | confirmed |
| Target card eyebrow | `KEEP` | MergeReview.tsx | confirmed (plan extension, not UI-SPEC-mandated) |

Grep assertions pass:
- `grep -F "archived, not deleted" apps/dashboard/src/app/(app)/entities/[id]/merge/MergeConfirmDialog.tsx` -> match
- `grep -F "Yes, merge" apps/dashboard/src/app/(app)/entities/[id]/merge/MergeConfirmDialog.tsx` -> match
- `grep -F "ARCHIVING" apps/dashboard/src/app/(app)/entities/[id]/merge/MergeReview.tsx` -> match
- `grep -F "/inbox?focus=resume-" apps/dashboard/src/app/(app)/entities/[id]/merge/actions.ts` -> match
- `grep -F "ulid()" apps/dashboard/src/app/(app)/entities/[id]/merge/MergeConfirmDialog.tsx` -> match

## Test coverage

### dashboard-api (57 pass, was 46; +11)

| File | Cases | What it covers |
|------|-------|----------------|
| `tests/merge-transactional.test.ts` | 3 | Full 4-step merge -> state='complete' + agent_runs row + publishOutput('entity_merge'); duplicate merge_id -> 409 (T-3-11-01); malformed merge_id -> 400 |
| `tests/merge-partial.test.ts` | 1 | `archiveNotionPage` throws mid-flight -> state='failed_at_notion_relations_copied' + inbox_index row kind='merge_resume' keyed to merge_id; agent_runs NOT written |
| `tests/merge-resume.test.ts` | 7 | Resume from `notion_archived` -> only rds + complete; resume from `failed_at_notion_relations_copied` -> archive + rds + complete; idempotent when already complete; 404 on unknown merge_id; `action=cancel` -> state='cancelled' (no Notion); `action=revert` -> unarchive + state='reverted'; 400 on malformed merge_id |

### dashboard (91 pass, was 85; +6)

| File | Cases | What it covers |
|------|-------|----------------|
| `tests/unit/merge-review.test.tsx` | 5 | Two-column render (KEEP + ARCHIVING eyebrows); diff panel counts + field listing; Confirm merge button; Dialog UI-SPEC copy (headline/body/primary); executeMerge called with target_id + source_id + ULID |
| `tests/unit/resume-merge-card.test.tsx` | +1 net (6 vs prior 5) | Original Resume + URL + error cases still pass; Revert test replaced by real-endpoint assertion (action=revert query param + "Merge reverted" success toast); Cancel test replaced by real-endpoint assertion (action=cancel + "Cancelled" success toast) |
| `tests/e2e/merge-audit.spec.ts` | 2 preview-gated | "Merge review page renders UI-SPEC-verbatim dialog copy" (requires seeded entity ids); "Partial merge failure redirects to Inbox Resume card" (requires PLAYWRIGHT_E2E_MERGE_FAILURE flag + seeded failure fixture) |

## Threat register dispositions

| Threat ID | Disposition | How |
|-----------|------------|-----|
| T-3-11-01 Replay | mitigate | `merge_id` ULID is PK on `entity_merge_audit`; duplicate INSERT hits `23505` unique-violation; handler returns 409 before any side-effects run. `MergeConfirmDialog` generates a fresh ULID per dialog open (tested). |
| T-3-11-02 Tampering (revert bypass) | mitigate | Revert is an explicit `?action=revert` query param. The handler writes a `state='reverted'` audit row — nothing silent. `/api/merge-resume` validates action value against `{resume, cancel, revert}` allow-list and 400s on anything else. |
| T-3-11-03 Destructive operation | mitigate | `archiveNotionPage` uses `notion.pages.update({ archived: true })` only. `grep pages.delete` on `services/dashboard-api/src/handlers/*.ts` returns empty. `archived: true` appears 5x in `notion-merge.ts`. |
| T-3-11-04 Info disclosure (diff JSON) | accept | `entity_merge_audit.diff` stores the diff for audit; Lambda is behind SigV4 Function URL + Kevin-only trust boundary. |
| T-3-11-05 Repudiation | mitigate | Two durable trails: `entity_merge_audit` (per-state timestamps + initiated_by) + `agent_runs` (agent_name='entity_merge_manual'). |
| T-3-11-06 DoS (infinite resume loop) | mitigate | State machine guards via `isPastOrEqual()` skip already-done steps. Recurring failure accumulates `failed_at_X` audit rows but does not re-run completed side-effects. Kevin sees the persistent Resume card and escalates. |

## Flow: UI -> handler -> back to UI

```
Kevin clicks "Merge duplicates" on /entities/<target>  (StatsRail, Plan 10)
  -> /entities/<target>/merge?source=<source>
  -> RSC fetches target + source via callApi (SigV4) in parallel
  -> <MergeReview /> renders two-column diff + sticky "Confirm merge" button
Kevin clicks "Confirm merge"
  -> <MergeConfirmDialog /> opens
  -> UI-SPEC verbatim headline / body / "Yes, merge" / "Cancel"
Kevin clicks "Yes, merge"
  -> useTransition: generate ULID -> call executeMerge Server Action
  -> Server Action validates MergeRequestSchema -> POST /entities/<target>/merge
     -> dashboard-api INSERT audit row (state='initiated') with merge_id PK
     -> if 23505 duplicate -> return 409 -> redirect /inbox?focus=resume-<merge_id>
     -> step 1 copyRelations + sleep 400ms
     -> step 2 archiveNotionPage (NEVER delete)
     -> step 3 RDS txn (mention_events repoint + entity_index status flip)
     -> step 4 agent_runs + publishOutput('entity_merge')
     -> return { ok: true, merge_id }
  -> Server Action redirect /entities/<target>
  -> SSE entity_merge -> open tabs router.refresh()
  -> Dossier reflects the new canonical name
```

If step N fails:
```
  -> handler catches, markFailed(lastOk, err) writes state='failed_at_<lastOk>' + inbox_index merge_resume row
  -> handler returns 500 { ok: false, merge_id, resumable: true }
  -> Server Action catch -> redirect /inbox?focus=resume-<merge_id>
  -> /inbox RSC re-fetches, ResumeMergeCard keyed to that merge_id is visible
  -> Kevin clicks Resume / Revert / Cancel -> /api/merge-resume?merge_id=...&action=<a>
  -> handler continues / unarchives / closes audit row
```

## Verification

- `pnpm --filter @kos/dashboard-api typecheck` -> clean
- `pnpm --filter @kos/dashboard-api test` -> **57 passed** (11 files)
- `pnpm --filter @kos/dashboard typecheck` -> clean
- `pnpm --filter @kos/dashboard test` -> **91 passed** (16 files, 2 skipped, 4 todo unchanged)
- `pnpm --filter @kos/dashboard build` -> succeeds; `/entities/[id]/merge` = 4.27 kB (202 kB first-load)

## Acceptance criteria (from plan)

**Task 1 — dashboard-api state machine:**
- [x] `grep -F "agentName: 'entity_merge_manual'"` in merge.ts -> match (Drizzle camelCase column)
- [x] `grep -F "notion_archived"` in merge.ts -> 5 matches
- [x] `grep -F "archived: true"` in notion-merge.ts -> 5 matches (and merge.ts never calls delete)
- [x] `! grep "pages.delete"` in merge.ts -> empty (exit 1)
- [x] `grep -F "setTimeout(r, 400)"` in merge.ts -> 1 match (P-06 rate limit)
- [x] `grep -F "failed_at_"` in merge.ts -> 3 matches
- [x] `grep -F "kind: 'merge_resume'"` in merge.ts -> 1 match
- [x] `grep -F "publishOutput('entity_merge'"` in merge.ts -> 1 match
- [x] All 11 merge tests pass

**Task 2 — merge review page + Dialog + E2E:**
- [x] `grep -F "archived, not deleted"` in MergeConfirmDialog.tsx -> match (UI-SPEC body verbatim)
- [x] `grep -F "Yes, merge"` in MergeConfirmDialog.tsx -> match (UI-SPEC primary verbatim)
- [x] `grep -F "ARCHIVING"` in MergeReview.tsx -> match (UI-SPEC eyebrow)
- [x] `grep -F "/inbox?focus=resume-"` in actions.ts -> match (failure redirect)
- [x] `grep -F "ulid()"` in MergeConfirmDialog.tsx -> match (client-side merge_id)
- [x] `pnpm --filter @kos/dashboard build` succeeds

## Deviations from Plan

### Rule 2 — Auto-added missing critical functionality

**1. ULID added as a dashboard-app dependency**
- **Found during:** Task 2 Server Action authoring.
- **Issue:** Plan wrote the Server Action as generating the ULID in its own code, but `ulid` was only a dependency of the Lambda — not of the Next app. Without it, client-side ULID generation in MergeConfirmDialog wouldn't compile.
- **Fix:** `pnpm --filter @kos/dashboard add ulid@2.3.0` (same version pinned server-side for consistency).
- **Files modified:** `apps/dashboard/package.json`, `pnpm-lock.yaml`
- **Commit:** `dc3a9d7`

**2. Action-validation allow-list on /api/merge-resume**
- **Found during:** Task 2 parameterisation of /api/merge-resume.
- **Issue:** Accepting an arbitrary `?action=` query param and forwarding it to the upstream gives the client a direct say in what the upstream URL looks like. Kevin-only or not, the right posture is to reject unknown actions at the route layer.
- **Fix:** Added `ACTIONS = new Set(['resume', 'cancel', 'revert'])` + early 400 on unknown values. Matches T-3-11-02 mitigation posture.
- **Files modified:** `apps/dashboard/src/app/api/merge-resume/route.ts`
- **Commit:** `dc3a9d7`

### Rule 1 — Auto-fix bugs

**3. merge-resume.test.ts: `archiveSpy` / `copyRelationsSpy` / `unarchiveSpy` TDZ during vi.mock hoist**
- **Found during:** First RED run (Task 1).
- **Issue:** `vi.mock()` factories are hoisted to the top of the module, so capturing the spies in outer `const` declarations before they're initialised hits "Cannot access 'copyRelationsSpy' before initialization".
- **Fix:** Inlined `vi.fn()` inside the mock factory; captured the spies via `import * as notionMerge; const archiveSpy = notionMerge.archiveNotionPage as ReturnType<typeof vi.fn>`. 7/7 resume tests pass.
- **Files modified:** `services/dashboard-api/tests/merge-resume.test.ts`
- **Commit:** `ae537d1`

**4. resume-merge-card.test.tsx: "Cancelled" assertion flipped from plainToast to successToast**
- **Found during:** First build of Task 2's Plan 09 behavior update.
- **Issue:** The Plan 09 ResumeMergeCard called `toast('Cancelled')` (plain) because the Cancel action was a stub. Task 2 routes Cancel through the real endpoint and toasts on success, so the copy now lives on `toast.success('Cancelled')`. The existing test asserted plain toast.
- **Fix:** Rewrote the Revert + Cancel tests to assert the URL contains `action=revert`/`action=cancel` and that success calls `toast.success('Merge reverted')`/`toast.success('Cancelled')`. The original "Plan 11 stub" description is now obsolete.
- **Files modified:** `apps/dashboard/tests/unit/resume-merge-card.test.tsx`
- **Commit:** `dc3a9d7`

**5. merge.ts / notion-merge.ts: grep-friendly comments**
- **Found during:** Acceptance grep verification.
- **Issue:** My initial comments used the literal phrase `notion.pages.delete` and `pages.delete` in prose explaining WHY the code doesn't call them. That false-positives the `! grep "pages.delete"` acceptance assertion.
- **Fix:** Rewrote the comments to use "the Notion page-deletion API" as the non-literal description. The ARCHIVE-NEVER-DELETE sentinel and the `archived: true` call site remain; the negative grep is now pure-negative.
- **Files modified:** `services/dashboard-api/src/handlers/merge.ts`, `services/dashboard-api/src/handlers/notion-merge.ts`
- **Commits:** `ae537d1`

### Rule 3 — Auto-fix blocking issues

**6. tsconfig any-types + error-narrow casts in test fakes**
- **Found during:** `pnpm typecheck` after GREEN run.
- **Issue:** Our hand-rolled Drizzle-chain mock in each merge test uses a self-referential `db` object inside `transaction`. TS7022 fires when TS can't infer the type. Also, `(err as { code: string })` on a fresh `new Error(...)` trips TS2352 "conversion of type ... may be a mistake."
- **Fix:** Annotated `makeDb(): any` / `db: any` with eslint-disable-line; narrowed the thrown error via `as Error & { code?: string }` with a then-`err.code = '23505'` assignment.
- **Files modified:** all 3 merge tests
- **Commit:** `ae537d1`

### Rule 3 — Infra recovery

**7. Working tree re-hydration via `git reset --soft` + `git checkout HEAD -- .`**
- **Found during:** execute_flow startup.
- **Issue:** The worktree base differed from the expected `43564cf0…` commit (actual was `ea72670…`). After the mandatory `git reset --soft` to the correct base, all files appeared as staged deletions.
- **Fix:** Ran `git checkout HEAD -- .` to restore the working tree. Then `pnpm install --frozen-lockfile` to re-hydrate `node_modules`.
- **Files modified:** none in source — infra recovery only.
- **Commit:** n/a (pre-task environment setup).

### Out-of-scope discoveries (logged, not fixed)

- `services/telegram-bot/src/handler.ts` — pre-existing console.log noise in the worktree, untouched.
- `TFOS-ui.html`, `TFOS-overview.html`, `tmp-deploy/` — pre-existing root-level untracked artefacts, untouched.

No Rule 4 triggered — the plan's architectural surface (state machine, merge_id PK, inbox_index merge_resume surfacing, Server Action redirect contract) all implemented as specified.

## Known Stubs

**copyRelations** walks all relation-typed Notion properties on the source page. Phase 3 does NOT add a dedup-marker property on copied relations (RESEARCH §14 describes `source_entity_notion_id` as one possible dedup key). Rationale: the natural set-diff on existing target relation ids gives idempotent re-copy for FREE — copying the same relation twice is detected by `existingIds.has(r.id)`. A marker property becomes necessary only if Kevin ever wants to un-merge by relation-origin (Phase 6+ concern); it's a forward-compatible addition.

**Per-field radio toggle in the diff panel** is documented in UI-SPEC §View 3.5 but not implemented. The dashboard-api merge handler doesn't yet accept a field-override map. If Kevin ever needs to pick which value wins on a per-field basis, Plan 11.5 adds an optional `overrides: Partial<EntityEditRequest>` field to `MergeRequestSchema` + handler step 2.5 that writes those fields to the target Notion page before the source is archived. Phase 3 keeps the simple behavior: canonical entity wins on every field.

**E2E `merge-audit.spec.ts`** tests are preview-gated (skip without `PLAYWRIGHT_BASE_URL` + seeded ids). Plan 12 wires the Vercel preview run against live seeded fixtures. The unit test coverage of MergeReview + MergeConfirmDialog is the primary gate for Phase 3 Gate 1.

## Threat Flags

None. Plan 11 introduces:
- `POST /entities/:target/merge` — enumerated in the plan's threat register (T-3-11-01..06), all mitigations implemented.
- `POST /entities/:target/merge/resume` — same threat register.
- `/entities/[id]/merge` RSC route — behind the existing middleware cookie gate, zod-validates source/target query params.
- `/api/merge-resume` now takes additional query params (target_id + action) — both validated at the route boundary.

No new trust boundaries, no new network surface beyond what the threat_model block enumerated.

## Ready-for handoffs

- **Plan 03-12 (PWA + Lighthouse + E2E):**
  - `/entities/[id]/merge` is ready for the <500 ms interactive budget measurement.
  - `tests/e2e/merge-audit.spec.ts` is a live E2E once the Vercel preview has a seeded source+target pair (`PLAYWRIGHT_SEED_SOURCE` + `PLAYWRIGHT_SEED_TARGET` env vars). The partial-failure test gates on `PLAYWRIGHT_E2E_MERGE_FAILURE=1` + a dashboard-api fixture that deliberately throws on step 2.
  - The merge_id ULID -> ResumeMergeCard round-trip is the end-to-end target for the NOTIFY + SSE latency test.
- **Phase 6 (agent-side entity-resolver merges):**
  - Reuse the same handler; agent path writes `initiated_by='agent:entity-resolver'` on the audit row (handler hard-codes `'kevin'` today — one-line change to read from request body).
  - MergeRequestSchema already accepts `diff` as a record<unknown>, so agent-produced diffs slot in without contract change.
- **Phase 7 (cost alarm):**
  - `agent_runs` rows with `agent_name='entity_merge_manual'` are queryable by the Phase 7 cost dashboard.

## Self-Check: PASSED

- FOUND: services/dashboard-api/src/handlers/merge.ts
- FOUND: services/dashboard-api/src/handlers/notion-merge.ts
- FOUND: services/dashboard-api/tests/merge-transactional.test.ts
- FOUND: services/dashboard-api/tests/merge-partial.test.ts
- FOUND: services/dashboard-api/tests/merge-resume.test.ts
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/merge/page.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/merge/MergeReview.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/merge/MergeConfirmDialog.tsx
- FOUND: apps/dashboard/src/app/(app)/entities/[id]/merge/actions.ts
- FOUND: apps/dashboard/tests/unit/merge-review.test.tsx
- FOUND: .planning/phases/03-dashboard-mvp/03-11-SUMMARY.md
- FOUND: commit ae537d1 (feat(03-11): merge state machine + transactional handler)
- FOUND: commit dc3a9d7 (feat(03-11): merge review page + MergeConfirmDialog + ResumeMergeCard action wiring)
