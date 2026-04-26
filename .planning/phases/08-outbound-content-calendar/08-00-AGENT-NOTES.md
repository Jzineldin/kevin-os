# Phase 8 Plan 08-00 — Agent Notes (Wave 0 Scaffold)

## Status

Scaffold complete. Not committed (per user instruction).

## Migration number chosen: **0020**

The plan reserved `0015` but at execute time the chain was already
`0001..0019` (Phases 4/5/6/7 + dashboard-roles all landed). Bumped to
the next free sequential number: `0020_phase_8_content_mutations_calendar_documents.sql`.

Existing layout at execute time:

```
0001_initial.sql
0002_hnsw_index.sql
0003_cohere_embedding_dim.sql
0004_pg_trgm_indexes.sql
0005_kos_inbox_cursor.sql
0006_embed_hash.sql
0007_entity_merge_audit.sql
0008_inbox_index.sql
0009_listen_notify_triggers.sql
0010_entity_timeline_indexes.sql
0011_dashboard_roles.sql
0012_phase_6_dossier_cache_and_timeline_mv.sql
0014_phase_7_top3_and_dropped_threads.sql
0015_kos_agent_writer_role.sql
0016_phase_4_email_and_dead_letter.sql
0017_phase_4_email_sender_role.sql
0018_phase_4_email_triage_role.sql
0019_phase_5_messaging.sql
0020_phase_8_content_mutations_calendar_documents.sql  ← THIS PLAN
```

Plans 08-01..08-05 should reference `0020` verbatim.

## Files created

### 7 service workspaces (services/<name>/{package.json,tsconfig.json,vitest.config.ts,src/handler.ts})

| Service | Plan that fills the body | Notable deps |
|---------|--------------------------|--------------|
| `@kos/service-content-writer` | 08-02 | `@aws-sdk/client-sfn`, `@kos/db`, `@kos/context-loader` (optional), `ulid`. NO Anthropic SDK (orchestrator only) |
| `@kos/service-content-writer-platform` | 08-02 | `@anthropic-ai/bedrock-sdk`, `@langfuse/otel`, `@opentelemetry/api`, `@kos/context-loader` (optional) |
| `@kos/service-publisher` | 08-03 | `@anthropic-ai/bedrock-sdk` (Haiku lightweight). NO Notion. NO SES |
| `@kos/service-mutation-proposer` | 08-04 | `@anthropic-ai/bedrock-sdk`, `@kos/resolver` (optional), `@kos/context-loader` (optional) |
| `@kos/service-mutation-executor` | 08-04 | `@notionhq/client`. NO Anthropic. NO SES. NO googleapis |
| `@kos/service-calendar-reader` | 08-01 | NO googleapis SDK — uses native fetch. NO Anthropic |
| `@kos/service-document-diff` | 08-05 | `pdf-parse`, `mammoth`, `@aws-sdk/client-s3`, `@anthropic-ai/bedrock-sdk` |

All stubs throw `'Phase 8 service <name>: handler body not yet implemented — see Plan NN'`.

### packages/contracts (4 new schema files + barrel + 14 tests)

- `packages/contracts/src/content.ts` — 6 exports (ContentTopicSubmittedSchema, ContentDraftSchema, DraftReadySchema, ContentApprovedSchema, ContentPublishedSchema, ContentPlatformEnum)
- `packages/contracts/src/mutation.ts` — 4 exports (MutationTypeEnum + 3 schemas)
- `packages/contracts/src/calendar.ts` — 2 exports (CalendarEventSchema, CalendarEventsReadSchema)
- `packages/contracts/src/document-version.ts` — 2 exports (DocumentVersionSchema, DocumentVersionCreatedSchema)
- `packages/contracts/test/phase-8.test.ts` — 14 tests, all passing
- `packages/contracts/src/index.ts` — extended barrel (see Naming Conflicts below)
- `packages/contracts/package.json` — added 4 new subpath exports

### Migration 0020 (5 tables + 9 indexes + 3 unique constraints)

- `content_drafts` — owner_id, UNIQUE (topic_id, platform), 2 indexes
- `content_publish_authorizations` — owner_id, FK draft_id ON DELETE CASCADE, 1 index
- `pending_mutations` — owner_id, 2 indexes (status + capture_id)
- `document_versions` — owner_id, UNIQUE (recipient_email, doc_name, sha256), 2 indexes
- `calendar_events_cache` — owner_id, composite PK (event_id, account), 2 indexes (one partial WHERE ignored_by_kevin = false)

### Drizzle schema (packages/db/src/schema.ts)

- Added imports: `numeric`, `boolean`, `InferSelectModel`, `InferInsertModel`
- Added 5 new pgTable definitions mirroring the SQL
- Added 10 type exports (`ContentDraftRow` + `ContentDraftInsert`, etc.)

### CDK skeleton

- `packages/cdk/lib/stacks/integrations-postiz.ts` — `wirePostizFargate()` exported signature; body throws; ~60 lines. Plan 08-03 fills body. NOT yet imported by `integrations-stack.ts`.

### BRAND_VOICE seed

- `.planning/brand/BRAND_VOICE.md` — `human_verification: false` front-matter present; 5 platform sections (Instagram, LinkedIn, TikTok, Reddit, Newsletter); placeholder examples Kevin must replace.

### Test fixtures

- `packages/test-fixtures/src/imperative-mutations.ts` — `IMPERATIVE_MUTATION_FIXTURES` (17 cases: SV positive, EN positive, mixed, regex false-positive, non-imperative)
- `packages/test-fixtures/src/postiz-mcp-responses.ts` — 5 canned JSON-RPC responses (success, delete-success, rate-limited, not-authed, list-integrations)
- `packages/test-fixtures/src/gcal-events.ts` — `GCAL_EVENTS_LIST_PRIMARY` + 2 OAuth refresh fixtures (success + invalid_grant)
- `packages/test-fixtures/src/document-diff-pairs.ts` — `DOCUMENT_DIFF_PAIRS` (3 cases: ESOP clause add, formatting-only, numeric change)
- `packages/test-fixtures/src/index.ts` — barrel updated

### Operator script

- `scripts/bootstrap-gcal-oauth.mjs` — stub with usage docstring; full impl in Plan 08-01.

## Verification

```
pnpm install                                   → 57 workspaces, ok
pnpm --filter @kos/contracts test              → 4 files, 50 tests pass (Phase 8: 14)
pnpm --filter @kos/contracts typecheck         → clean
pnpm --filter @kos/db typecheck                → clean
pnpm --filter @kos/cdk typecheck               → clean
pnpm --filter @kos/test-fixtures typecheck     → clean
pnpm --filter @kos/service-content-writer typecheck         → clean
pnpm --filter @kos/service-content-writer-platform typecheck → clean
pnpm --filter @kos/service-publisher typecheck             → clean
pnpm --filter @kos/service-mutation-proposer typecheck     → clean
pnpm --filter @kos/service-mutation-executor typecheck     → clean
pnpm --filter @kos/service-calendar-reader typecheck       → clean
pnpm --filter @kos/service-document-diff typecheck         → clean
pnpm --filter @kos/service-{email-triage,triage,email-sender} typecheck → clean (no regressions)
node scripts/validate-migration-syntax.mjs ...0020...sql   → OK
node --check scripts/bootstrap-gcal-oauth.mjs              → OK
pnpm -r typecheck                                          → no errors
```

`pnpm -r test` shows pre-existing CDK test failures with `ENOSPC: no space
left on device` while bundling Lambda assets to `/tmp` — these are
**unrelated to Phase 8 scaffold work**:
- Disk filled to 89% during the test run; CDK synth bundles each Lambda's
  esbuild output through `/tmp/kos-cdk-test-*` and trips ENOSPC.
- The `integrations-postiz.ts` skeleton has zero call sites — no test in
  the suite references it.
- Direct `pnpm --filter @kos/cdk typecheck` passes cleanly.

## Naming conflict resolutions in @kos/contracts barrel

Two name collisions surfaced during typecheck and are documented in
`src/index.ts`:

1. **`DraftReadySchema` / `DraftReady`**:
   - `email.ts` already exports these (Phase 4 — one-per-email shape)
   - `content.ts` exports the same names (Phase 8 — drafts grouped by topic)
   - **Resolution**: barrel keeps the email export under the bare name
     (existing email-triage code uses bare-name barrel imports) and
     re-exports the Phase 8 schema as `ContentDraftReadySchema` /
     `ContentDraftReady`. Phase 8 callers wanting the bare name use
     `import { DraftReadySchema } from '@kos/contracts/content';`.
   - The `phase-8.test.ts` uses `as ContentDraftReadySchema` aliasing on
     import to make this explicit.

2. **`CalendarEvent` / `CalendarEventSchema`**:
   - `dashboard.ts` exports a Phase 3 dashboard-aggregated CalendarEvent
     (unions Granola + GCal events for the dashboard surface)
   - `calendar.ts` exports the Phase 8 GCal-mirror shape
   - **Resolution**: barrel re-exports Phase 8's as `GcalCalendarEventSchema`
     / `GcalCalendarEvent`. Phase 8 callers wanting the bare name use
     `import { CalendarEventSchema } from '@kos/contracts/calendar';`.

Both naming choices are deviations from the Plan's prescriptive
must-have list (which named both `DraftReadySchema` and the Phase 8
schemas without acknowledging the email/dashboard collisions). The
underlying schemas, types, and tests behave exactly as specified —
only the barrel export names changed.

## Other deviations from plan

- **None of the new services run real tests** (only `--passWithNoTests`).
  This matches the Phase 4/5 scaffold pattern and the plan's intent of
  pure stubs.
- **`@kos/context-loader` and `@kos/resolver` listed as `peerDependenciesMeta.optional`**
  in content-writer, content-writer-platform, and mutation-proposer
  packages. Mirrors Phase 4's email-triage handling — these workspaces
  exist today, so the dep will resolve. The optional marker preserves the
  Plan-04-style runtime guard for future re-orgs.
- **`@kos/test-fixtures` import-only**: did NOT extend test-fixtures
  with a build step or run-time tests — fixtures remain plain TS modules
  re-exported via barrel.
- **No CDK registration**: `integrations-postiz.ts` is a standalone file;
  Plan 08-03 will wire it into `integrations-stack.ts`.

## Plan-implied todos for Plan 08-01..08-05

- 08-01 (calendar-reader): implement OAuth refresh, paginated event list,
  upsert into `calendar_events_cache`, emit `calendar.events_read`. Use
  `gcal-events.ts` fixture for unit tests. Implement bootstrap-gcal-oauth.mjs
  fully.
- 08-02 (content-writer + content-writer-platform): Step Functions Map
  fan-out, BRAND_VOICE.md baked in via esbuild text loader, fail-fast
  when `human_verification: false`. Use `postiz-mcp-responses.ts` (for
  list-integrations health check).
- 08-03 (publisher + Postiz Fargate): fill `wirePostizFargate` body;
  publisher Lambda calls Postiz MCP via VPC-internal DNS.
- 08-04 (mutation-proposer + mutation-executor): regex prescreen + Haiku
  + Sonnet pipeline; archive-not-delete executor. Use
  `imperative-mutations.ts` fixture for the regex + Haiku stage tests.
- 08-05 (document-diff): pdf-parse + mammoth + Haiku diff summary. Use
  `document-diff-pairs.ts` for unit tests.
