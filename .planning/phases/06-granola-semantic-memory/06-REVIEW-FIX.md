---
phase: 06-granola-semantic-memory
fixed_at: 2026-04-25T00:00:00Z
review_path: .planning/phases/06-granola-semantic-memory/06-REVIEW.md
iteration: 1
findings_in_scope: 12
fixed: 12
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-04-25
**Source review:** .planning/phases/06-granola-semantic-memory/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 12 (5 Critical + 7 Warning; Info deferred per fix_scope=critical_warning)
- Fixed: 12
- Skipped: 0

All Critical findings targeted schema-drift bugs where handler queries selected columns that never existed on the shipped tables; each fix aligned code to the real schema in `packages/db/src/schema.ts` + migration 0001/0012. Warning fixes added prompt-injection delimiters, D-28 observability, a size cap on Notion block reads, and removed a dead code branch + a misleading ON CONFLICT clause.

## Fixed Issues

### CR-01: `loadKevinContextBlock` queries non-existent columns `section` / `body`

**Files modified:** `packages/context-loader/src/kevin.ts`, `packages/context-loader/test/loadContext.test.ts`
**Commit:** 4a7e82e
**Applied fix:** Renamed SELECT + WHERE columns to `section_heading` / `section_body` matching the Phase 2 schema. Added `SECTION_HEADINGS_BY_KEY` mapping from logical `KevinContextBlock` keys ('current_priorities', 'active_deals', ...) to Kevin's actual Notion section headings ('Current priorities', 'Active deals', "Who's who", 'Blocked on', 'Recent decisions', 'Open questions'). Updated the unit test mock fixture rows to use the new column shape so the test now validates against the real column names.

### CR-02: `fetchDossiers` selects `entity_id` from `entity_index` (column is `id`)

**Files modified:** `packages/context-loader/src/loadContext.ts`
**Commit:** a16d0c8
**Applied fix:** SELECT now aliases `id AS entity_id` in `fetchDossiers`, preserving the `EntityDossier` API shape while pointing to the actual PK column. Also addressed the CR-02 downstream note about `fetchLinkedProjects`: corrected `p.project_id` → `p.id AS project_id`, `e.entity_id` → `e.id`, and `e.linked_project_ids` → `e.linked_projects` (the shipped column is text[] of Notion page ids, not uuid[]). The JOIN now uses `p.notion_page_id = ANY(e.linked_projects)` to match the actual data type. `recent_mentions` array type in the projection SELECT left as `ARRAY[]::jsonb[]` since that placeholder matches callers.

### CR-03: `azure-search-indexer-transcripts` + `-daily-brief` read non-existent `agent_runs` columns

**Files modified:** `services/azure-search-indexer-transcripts/src/handler.ts`, `services/azure-search-indexer-transcripts/test/handler.test.ts`, `services/azure-search-indexer-daily-brief/src/handler.ts`, `services/azure-search-indexer-daily-brief/test/handler.test.ts`
**Commit:** 6733f5f
**Applied fix:** Both handlers now SELECT `output_json` (jsonb) and `started_at` (timestamptz) — the actual `agent_runs` columns per `schema.ts:114,121`. The callers read `r.output_json` and `r.started_at` throughout the downstream mapping (title, snippet, content_for_embedding, indexed_at, cursor advancement). Unit test fixtures updated in lockstep so the mocks now reflect the real column names and would have caught the original drift.

### CR-04: `azure-search-indexer-projects` selects `project_id` from `project_index` (column is `id`)

**Files modified:** `services/azure-search-indexer-projects/src/handler.ts`
**Commit:** 0652d11
**Applied fix:** SELECT now `id AS project_id`, keeping the downstream row shape and the Azure document id format (`project:${r.project_id}`) stable.

### CR-05: `azure-search-indexer-entities` selects `entity_id` from `entity_index` (column is `id`)

**Files modified:** `services/azure-search-indexer-entities/src/handler.ts`
**Commit:** 645c427
**Applied fix:** SELECT now `id AS entity_id`, keeping the document id format and `entity_ids: [r.entity_id]` payload intact.

### WR-01: Timeline live-overlay dedup compares incompatible UUID namespaces

**Files modified:** `services/dashboard-api/src/handlers/timeline.ts`
**Commit:** 5cdfc52
**Applied fix:** Changed the live-overlay dedup filter from `id::text NOT IN (SELECT id FROM mv ...)` to `capture_id NOT IN (SELECT capture_id FROM mv ...)`. `capture_id` is present in both MV and mention_events branches (the former casts it to text; the latter holds it as a ULID column), so the NOT IN now compares identifiers from the same namespace and actually filters duplicates during the 5-min refresh race window. `live.id` kept as-is so React keys stay stable. The existing test regex `NOT IN \(SELECT[^)]*FROM mv` still matches.

### WR-02: Dossier-loader injects untrusted corpus text without prompt-injection delimiters

**Files modified:** `services/dossier-loader/src/vertex.ts`
**Commit:** 0b52b36
**Applied fix:** Replaced `--- CORPUS START ---` / `--- CORPUS END ---` with `<corpus>` / `</corpus>` tags matching the transcript-extractor pattern, and added an explicit "Prompt safety" section to the system instruction telling Gemini that content inside `<corpus>` is aggregated data (emails, transcripts, LinkedIn DMs, mention_events, agent_runs outputs) — never commands. Directives inside the corpus are to be summarised as meeting/email content, not followed.

### WR-03: Dossier-loader doc comment claims Vertex context caching but code doesn't use it

**Files modified:** `services/dossier-loader/src/vertex.ts`, `services/dossier-loader/src/handler.ts`
**Commit:** 79c192d
**Applied fix:** Updated both file headers so the doc promise matches current code behaviour. `vertex.ts` now annotates the pricing block with "Cached content: 25% discount on input (NOT YET REALISED — see below)" and includes a TODO block calling out that `cachedContents.create` is a Phase 7 follow-up. `handler.ts` header changed "with context caching enabled" to a note that caching is deferred. Also updated "agent_runs context.summary" → "agent_runs output_json.summary" for schema consistency with CR-03.

### WR-04: `dossier-loader` handler skips D-28 OTel setup + Langfuse flush

**Files modified:** `services/dossier-loader/src/handler.ts`
**Commit:** 315502e
**Applied fix:** Mirrored the pattern used by entity-timeline-refresher, granola-poller, and transcript-extractor: `await setupOtelTracingAsync()` before the Vertex call, and `await langfuseFlush()` inside a `finally` block so the Lambda return is never blocked by observability infrastructure (Pitfall 9). Vertex `generateContent` spans will now reach Langfuse. Also hoisted the 24-hour TTL to a named constant `GEMINI_FULL_DOSSIER_TTL_SECONDS` with a D-21 doc comment.

### WR-05: `dossier-loader` handler has unreachable skip branch

**Files modified:** `services/dossier-loader/src/handler.ts`, `services/dossier-loader/test/handler.test.ts`
**Commit:** e76c9d6
**Applied fix:** Removed the dead `if (detail.entity_ids.length === 0) return { status: 'skipped', ... }` branch; `FullDossierRequestedSchema.min(1)` already rejects empty arrays at Zod.parse before the handler body runs. Narrowed the return type to `status: 'ok'` (removed `'skipped'` variant that could never be produced). Renamed the existing test from "skips when entity_ids is empty" to "rejects empty entity_ids via Zod (FullDossierRequestedSchema.min(1))" — the body was already asserting `.rejects.toBeDefined()`, the old test name just mis-described intent.

### WR-06: `writeTranscriptIndexed` uses `ON CONFLICT DO NOTHING` without a conflict target

**Files modified:** `services/transcript-extractor/src/persist.ts`
**Commit:** 0c6efcb
**Applied fix:** Applied the minimal-fix option from the review — dropped the `ON CONFLICT DO NOTHING` clause since it only guarded against astronomical PK collisions on `agent_runs.id` (uuid DEFAULT gen_random_uuid()). Real idempotency is enforced upstream by `findPriorOkRun` in handler.ts:126. Added an explanatory comment so future readers know why the bare INSERT is correct. A real unique index on `(owner_id, capture_id) WHERE agent_name='transcript-indexed'` would require a new migration — out of scope for a Warning, noted in comment if duplicates are ever observed.

### WR-07: `readTranscriptBody` has no size cap; large transcripts can blow the Lambda heap

**Files modified:** `services/transcript-extractor/src/notion.ts`
**Commit:** 0522ad5
**Applied fix:** Added `RAW_LENGTH_CAP = 64_000` mirroring `services/granola-poller/src/notion.ts:21`. The walker now tracks a running `total` during block enumeration, short-circuits pagination once the cap is hit, and slices once at the end as a belt-and-braces guard. Behaviour is unchanged for transcripts under 64 KB. Sonnet's 200k-token input cap already clipped useful payload downstream, so this prevents wasted heap + runtime on pathologically large Granola pages without losing signal.

---

_Fixed: 2026-04-25_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
