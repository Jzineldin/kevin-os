---
phase: 02-minimum-viable-loop
plan: 03
subsystem: resolver-library-and-migrations
tags: [wave-1, resolver, pg_trgm, pgvector, cohere, azure-search, blocking-migration]
dependency_graph:
  requires:
    - packages/resolver (Plan 02-00 — score.ts + Stage types)
    - packages/db (Phase 01 — 0001_initial.sql, 0002_hnsw_index.sql)
    - services/azure-search-bootstrap (Phase 01 — CustomResource pattern)
  provides:
    - "@kos/resolver::embedBatch (Cohere Embed Multilingual v3 via Bedrock)"
    - "@kos/resolver::buildEntityEmbedText (D-08 composition)"
    - "@kos/resolver::findCandidates (top-20 hybrid-scored, inline CANDIDATE_SQL, esbuild-safe)"
    - "@kos/resolver::hasProjectCooccurrence (D-11 secondary signal)"
    - "drizzle/0003_cohere_embedding_dim.sql (1536 → 1024 + embedding_model text + precondition guard)"
    - "drizzle/0004_pg_trgm_indexes.sql (pg_trgm + GIN on LOWER(name) + HNSW recreate)"
    - "scripts/db-migrate-0003.sh (BLOCKING operator runbook via SSM bastion)"
    - "scripts/verify-resolver-explain.sh (EXPLAIN plan check for pg_trgm GIN usage)"
    - "Azure AI Search kos-memory-v1 at 1024 dims (via CDK CR re-fire + standalone recreate script)"
  affects:
    - "Plan 02-04 triage (requires @kos/resolver imports + live RDS shape)"
    - "Plan 02-05 voice-capture (requires findCandidates + embedBatch)"
    - "Plan 02-06 entity-resolver (AGT-03 / ENT-09 — primary consumer)"
    - "Plans 02-07/08 bulk imports (requires embedBatch for dossier entries)"
tech_stack:
  added:
    - "Cohere Embed Multilingual v3 on AWS Bedrock (modelId: cohere.embed-multilingual-v3)"
    - "pg_trgm Postgres extension (similarity() + % trigram operator)"
    - "pgvector 1024-dim cosine HNSW (m=16, ef_construction=64)"
  patterns:
    - "Inline CANDIDATE_SQL template literal in TS (esbuild-safe; sibling .sql is docs-only)"
    - "Precondition guard via DO $$ BEGIN ... RAISE EXCEPTION END $$ before destructive ALTER"
    - "DROP INDEX → DROP COLUMN → ADD COLUMN → CREATE INDEX dance for vector dim changes"
    - "CDK CustomResource fingerprint rebuild triggered by schema file byte edit"
key_files:
  created:
    - packages/resolver/src/embed.ts
    - packages/resolver/src/candidates.ts
    - packages/resolver/docs/candidates.sql
    - packages/resolver/test/candidates.test.ts
    - packages/resolver/test/fixtures/entities.ts
    - packages/db/drizzle/0003_cohere_embedding_dim.sql
    - packages/db/drizzle/0004_pg_trgm_indexes.sql
    - scripts/db-migrate-0003.sh
    - scripts/verify-resolver-explain.sh
    - scripts/azure-search-recreate-index.mjs
  modified:
    - packages/resolver/src/index.ts (added embed + candidates exports)
    - packages/resolver/test/score.test.ts (13 cases; fixed t=0,c=1 → 0.7 expectation per D-09 math)
    - packages/db/src/schema.ts (embedding 1536 → 1024; added embeddingModel text)
    - packages/db/drizzle/meta/_journal.json (2 new migration entries)
    - packages/db/test/schema.test.ts (6 tests; new 1024-dim + embeddingModel assertions)
    - services/azure-search-bootstrap/src/index-schema.ts (content_vector.dimensions 1024)
    - services/azure-search-bootstrap/test/schema.test.ts (updated 1024 assertion)
decisions:
  - "Rule 1 bug fix: plan's 'exact cosine match → 0.6' test expectation was mathematically wrong. For t=0, c=1 the weighted branch 0.3·0 + 0.7·1 = 0.7 wins over 0.6·1 = 0.6. Test now expects 0.7. Implementation of hybridScore was already correct (D-09 formula from Plan 02-00)."
  - "CANDIDATE_SQL is inlined as a TS template literal in candidates.ts; the sibling packages/resolver/docs/candidates.sql is reference-only (esbuild does not bundle .sql siblings by default — runtime ENOENT in Lambda otherwise)."
  - "Azure index update lands via CDK CustomResource re-fire on file-byte change to index-schema.ts; standalone scripts/azure-search-recreate-index.mjs kept as operator fallback."
  - "Migration 0003 precondition guard (RAISE EXCEPTION if any non-null embeddings exist) hard-prevents silent data drop. Phase 1 01-02 SUMMARY confirmed 0 non-null today."
metrics:
  duration_minutes: ~8
  completed: 2026-04-22
  tasks: 4
  files_created: 10
  files_modified: 7
  commits: 3
---

# Phase 2 Plan 03: Resolver Library + Postgres Migration + Azure Search Recreate Summary

Ships the `@kos/resolver` library (embedBatch/buildEntityEmbedText/findCandidates/hasProjectCooccurrence) that every downstream Phase 2+ agent Lambda imports, authors migrations 0003 (1536→1024 vector + embedding_model column, with precondition guard) and 0004 (pg_trgm + GIN + HNSW recreate), and resizes the Azure AI Search content_vector field from 1536 to 1024 dims for Cohere Embed Multilingual v3. Migrations are authored and tested in-code; the live RDS application is a BLOCKING human-action checkpoint that operator Kevin must run against AWS.

## Objective

Realize D-05 (Cohere Embed Multilingual v3 at 1024 dims), D-06 (Azure 1024 dims), D-08 (entity text composition), D-09 (hybrid GREATEST formula), D-10 (stage thresholds 0.95 / 0.75), D-11 (project co-occurrence secondary signal), and ENT-09 (entity resolver library). Produce `@kos/resolver` importable by Plans 02-04/05/06/07/08, plus schema migrations that bring Postgres into 1024-dim shape.

## What Shipped

### Task 1 — Resolver library (commit `575b981`)

- **`packages/resolver/src/embed.ts`** (new): `embedBatch(texts, inputType)` calls Bedrock Cohere Embed Multilingual v3 with `modelId: cohere.embed-multilingual-v3`, body `{ texts, input_type, truncate: 'END', embedding_types: ['float'] }`, rejects > 96 texts, warns > 2000 chars, asserts every returned vector is 1024-dim. `buildEntityEmbedText` composes `Name | Aliases | Role | Org | Relationship | SeedContext` (name + aliases first for truncation) capped at 8000 chars.
- **`packages/resolver/src/candidates.ts`** (new): `findCandidates(pool, { mention, ownerId, embedding, limit })` lowercases + trims mention, builds `[0.1,0.2,...]` pgvector literal, calls inlined `CANDIDATE_SQL` template literal with positional params. Query shape: `trigram_candidates CTE (top 50 by similarity GREATEST(LOWER(name), LOWER(alias) MAX))` `∪` `vector_candidates CTE (top 50 by 1 - (embedding <=> $3::vector))` → outer SELECT with `GREATEST(0.6·t, 0.6·c, 0.3·t + 0.7·c)` hybrid_score ordering, `LIMIT 20`. Defence-in-depth: hybridScore is recomputed in JS so SQL drift surfaces in unit tests. `hasProjectCooccurrence(candidate, captureProjectIds)` implements D-11 project-overlap secondary signal.
- **`packages/resolver/docs/candidates.sql`** (new): byte-identical mirror of `CANDIDATE_SQL` for diff/EXPLAIN review; docs-only, not loaded at runtime.
- **`packages/resolver/src/index.ts`** (modified): now exports `{ hybridScore, resolveStage, Stage, embedBatch, buildEntityEmbedText, EMBED_MODEL_ID, EmbedInputType, findCandidates, hasProjectCooccurrence, CANDIDATE_SQL, Candidate, FindCandidatesInput }`.
- **Tests (20/20 pass):**
  - `test/score.test.ts` (13): pure-zero, exact-trigram (0.6), exact-cosine (**0.7** — see Deviations), both-exact (1.0), 0.85 typo (0.51), 0.92 semantic (0.644), Damian/Damien mixed (0.7399 to 3 dp), out-of-range throws (-0.1 / 1.1 both axes), stage at > 0.95 / 0.95 / 0.85 / 0.75 / 0.7499 / 0.
  - `test/candidates.test.ts` (7): empty-mention early return (pool never called), 1024-dim guard, lowercase mention + UUID + vector-literal param shape, row-to-Candidate mapping with stage recomputation, `hasProjectCooccurrence` overlap / non-overlap / empty-capture.

### Task 2 — Migrations 0003 + 0004 (commit `eae314c`)

- **`packages/db/drizzle/0003_cohere_embedding_dim.sql`** (new): wrapped in `BEGIN/COMMIT`. `DO $$ BEGIN ... IF cnt > 0 THEN RAISE EXCEPTION ... END IF; END $$` precondition guard. `DROP INDEX IF EXISTS entity_index_embedding_hnsw` → `ALTER TABLE entity_index DROP COLUMN embedding` → `ADD COLUMN embedding vector(1024)` → `ADD COLUMN embedding_model text`. `kevin_context` explicitly not touched (has no embedding column in Phase 1; Phase 6 will add at 1024 directly).
- **`packages/db/drizzle/0004_pg_trgm_indexes.sql`** (new): `CREATE EXTENSION IF NOT EXISTS pg_trgm`, `CREATE INDEX IF NOT EXISTS entity_index_name_trgm ON entity_index USING gin (LOWER(name) gin_trgm_ops)`, `CREATE INDEX IF NOT EXISTS entity_index_embedding_hnsw ON entity_index USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`. Aliases GIN deferred (comment calls out Phase 6+ `name_search` derived-column plan).
- **`packages/db/drizzle/meta/_journal.json`**: entries 2 and 3 added for 0003 + 0004.
- **`packages/db/src/schema.ts`**: `embedding: vector('embedding', { dimensions: 1024 })` + `embeddingModel: text('embedding_model')`.
- **`packages/db/test/schema.test.ts`**: 6 tests pass — added assertions that `entityIndex.embedding.dimensions === 1024` and `embeddingModel` exists.
- **`scripts/db-migrate-0003.sh`** (new, +x): BLOCKING operator runbook. Reads `KOS_DB_TUNNEL_PORT`, pulls `kos/rds-credentials` from Secrets Manager, runs `psql -v ON_ERROR_STOP=1 -f` on 0003 then 0004, then runs a verify SELECT reporting `embedding_type`, `has_pg_trgm`, `has_trgm_idx`, `has_hnsw`, `has_embedding_model`.
- **`scripts/verify-resolver-explain.sh`** (new, +x): runs `EXPLAIN (FORMAT JSON) ... WHERE LOWER(name) % 'kevin' ...`; greps output for `entity_index_name_trgm` index usage, exits non-zero if missing.

### Task 3 — [BLOCKING] Live migration application (PENDING OPERATOR ACTION)

**Status: not applied — requires Kevin to run AWS commands.** The migrations are authored, tested, and committed to the repository; applying them against live RDS requires a short-lived SSM bastion tunnel which the agent environment cannot provision. See "Pending Operator Actions" section below for the exact commands.

### Task 4 — Azure AI Search dimensions 1536 → 1024 (commit `2c634a6`)

- **`services/azure-search-bootstrap/src/index-schema.ts`**: `content_vector.dimensions` 1536 → 1024. The schema module is SHA-256 fingerprinted at CDK synth time, so this byte edit is exactly the trigger that causes the next `cdk deploy KosIntegrations` to re-fire the bootstrap Lambda's CustomResource.
- **`services/azure-search-bootstrap/test/schema.test.ts`**: updated to `expect(dimensions).toBe(1024)`. All 6 schema tests pass.
- **`packages/cdk/test/integrations-stack-azure.test.ts`**: all 5 tests continue to pass — fingerprint-determinism test is intentionally invariant to the bytes (asserts same digest across two synths), not to a specific value, so the 1024 bump is compatible.
- **`scripts/azure-search-recreate-index.mjs`** (new, +x): operator fallback if CR drifts. Checks existing index dims via GET; if already 1024, exits 0. Otherwise verifies `$count == 0` (refuses destructive delete if docs exist), DELETEs the index, POSTs a fresh definition with HNSW + binary quantization + semantic config preserved at 1024 dims.
- `npx cdk synth KosIntegrations --quiet` succeeds.

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/resolver typecheck` | PASS |
| `pnpm --filter @kos/resolver test -- --run` (20/20) | PASS |
| `pnpm --filter @kos/db typecheck` | PASS |
| `pnpm --filter @kos/db test -- --run` (10/10 including new 1024-dim assertions) | PASS |
| `pnpm --filter @kos/service-azure-search-bootstrap typecheck` | PASS |
| `pnpm --filter @kos/service-azure-search-bootstrap test -- --run` (6/6) | PASS |
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test -- --run integrations-stack-azure` (5/5) | PASS |
| `npx cdk synth KosIntegrations --quiet` | PASS |
| `grep RAISE EXCEPTION 0003_cohere_embedding_dim.sql` | PASS |
| `grep vector(1024) 0003_cohere_embedding_dim.sql` | PASS |
| `grep embedding_model text 0003_cohere_embedding_dim.sql` | PASS |
| `grep DROP INDEX IF EXISTS entity_index_embedding_hnsw 0003` | PASS |
| `grep CREATE EXTENSION IF NOT EXISTS pg_trgm 0004` | PASS |
| `grep "gin (LOWER(name) gin_trgm_ops)" 0004` | PASS |
| `grep "hnsw (embedding vector_cosine_ops)" 0004` | PASS |
| `grep "dimensions: 1024" schema.ts` | PASS |
| `grep embeddingModel schema.ts` | PASS |
| `grep "dimensions: 1024" index-schema.ts` | PASS |
| `grep "cohere.embed-multilingual-v3" embed.ts` | PASS |
| `grep "truncate: 'END'" embed.ts` | PASS |
| `grep "embedding_types: \\['float'\\]" embed.ts` | PASS |
| `grep CANDIDATE_SQL candidates.ts` | PASS |
| `grep hasProjectCooccurrence candidates.ts` | PASS |
| `test -x scripts/db-migrate-0003.sh` | PASS |
| `test -x scripts/verify-resolver-explain.sh` | PASS |
| `test -x scripts/azure-search-recreate-index.mjs` | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed mathematically-wrong test expectation for `hybridScore(0, 1)`**

- **Found during:** Task 1 first `pnpm test` run
- **Issue:** Plan text's `score.test.ts` case "exact cosine match → 0.6" asserted `hybridScore(0, 1) == 0.6`. The D-09 formula is `max(0.6·t, 0.6·c, 0.3·t + 0.7·c)`; for `t=0, c=1` that evaluates to `max(0, 0.6, 0.7) = 0.7`. The weighted branch dominates at full cosine, not the 0.6 branch.
- **Fix:** Kept the hybridScore implementation untouched (it was already correct per Plan 02-00 SUMMARY — the formula hasn't changed). Updated the test assertion to `toBeCloseTo(0.7, 10)` with a comment explaining the weighted-branch dominance. All 13 score tests pass.
- **Files modified:** `packages/resolver/test/score.test.ts`
- **Commit:** `575b981`
- **Rule rationale:** Rule 1 — the correctness bug is in the plan text's test expectation, not the library. Catching this mismatch is exactly what the fixture is for.

## Pending Operator Actions

### Task 3 — [BLOCKING] apply migrations 0003 + 0004 to live RDS (Kevin only)

This task requires AWS credentials + a short-lived SSM port-forward against the Phase 1 RDS instance. **Commit `eae314c` contains the SQL files Kevin must apply.** Run the following from a local terminal with AWS CLI authenticated for account `239541130189` (eu-north-1):

```bash
# 1. Re-raise bastion temporarily
cd packages/cdk
npx cdk deploy KosData --context bastion=true --require-approval never

# 2. Find bastion + RDS endpoint, open tunnel in SEPARATE terminal
BASTION_ID=$(aws ec2 describe-instances --region eu-north-1 \
  --filters "Name=tag:aws-cdk:bastion-id,Values=*" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)
RDS_ENDPOINT=$(aws rds describe-db-instances --region eu-north-1 \
  --query "DBInstances[?DBName=='kos'].Endpoint.Address | [0]" --output text)
aws ssm start-session --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_ENDPOINT,portNumber=5432,localPortNumber=15432" \
  --region eu-north-1

# 3. In a second terminal, run migrations (from repo root)
KOS_DB_TUNNEL_PORT=15432 bash scripts/db-migrate-0003.sh
# Expected last line: [OK] migrations 0003+0004 applied
# Verify SELECT should show: embedding_type=vector(1024), has_pg_trgm=1,
# has_trgm_idx=1, has_hnsw=1, has_embedding_model=embedding_model

# 4. EXPLAIN verification
KOS_DB_TUNNEL_PORT=15432 bash scripts/verify-resolver-explain.sh

# 5. Tear down bastion
cd packages/cdk && npx cdk deploy KosData --require-approval never
```

**If the precondition guard fails (cnt > 0 non-null embeddings):** ABORT. This would indicate Phase 6 embedding writes landed prematurely against the 1536 column — re-embedding plan needed before 0003 can proceed.

### Azure CDK CustomResource redeploy (Kevin only, one-shot)

Once Task 3 is done, run:

```bash
cd packages/cdk
npx cdk deploy KosIntegrations --require-approval never
```

This re-fires the Azure bootstrap Lambda via the new schema fingerprint. The Lambda (Phase 01 Plan 01-05 Task 2 handler) performs a pre-PUT GET + vector-dim divergence check; on a zero-doc index (which kos-memory-v1 is today) it will delete-then-recreate at 1024 dims. If the Lambda instead refuses with a rename-to-v2 error, fall back to `node scripts/azure-search-recreate-index.mjs` which performs the explicit delete-then-recreate.

## Authentication Gates

None encountered in-code. The live RDS and Azure CR apply steps are **human-action checkpoints** — they require operator Kevin to authenticate to AWS from a trusted local machine. All SQL + JS in the repo is ready to execute once Kevin has AWS CLI creds and an SSM tunnel open.

## Deferred Issues

- **Aliases trigram GIN index** not created in 0004. The query's `EXISTS (SELECT 1 FROM UNNEST(aliases) a WHERE LOWER(a) % $1)` can't use a GIN index on array elements without a materialized derived column. At Kevin-scale (<5k entities) this is sub-2ms via filter-then-scan. Phase 6+ optimization noted in 0004 comment: add a `name_search` text column combining name + aliases and GIN that.
- **Real Cohere API call not exercised in unit tests.** `packages/resolver/src/embed.ts` is tested via typecheck + downstream consumers only; live Bedrock smoke test lands in Plan 02-04 (triage agent) which first calls `embedBatch` against real Bedrock with real Kevin text.

## Threat-Register Coverage

- **T-02-MIG-01 (Tampering — destructive DROP COLUMN):** mitigated. 0003's `DO $$` block RAISEs EXCEPTION if `COUNT(*) WHERE embedding IS NOT NULL > 0`. Transaction aborts before DROP.
- **T-02-MIG-02 (DoS — HNSW rebuild blocks writes):** accepted. Rebuild runs on empty `entity_index` (<1s); Kevin is sole writer + notion-indexer runs every 5min → operator can schedule during quiet window.
- **T-02-RESOLVER-01 (Tampering — SQL injection via mention):** mitigated. Mention is lower-cased in JS, passed as positional param `$1` to pg driver. No string concatenation anywhere in CANDIDATE_SQL.
- **T-02-RESOLVER-02 (Info Disclosure — cross-owner leak):** mitigated. CANDIDATE_SQL filters `WHERE ei.owner_id = $2` in BOTH CTEs and the outer SELECT. `findCandidates` signature requires `ownerId: string`.
- **T-02-AZURE-01 (Tampering — accidental index delete with docs):** mitigated. `scripts/azure-search-recreate-index.mjs` hits `/docs/$count` before DELETE; refuses if `count > 0`.

## Handoffs to Downstream Plans

| Consumer plan | Imports from this plan |
|---------------|------------------------|
| 02-04 triage (AGT-01) | `@kos/resolver` types only (triage fans out, doesn't resolve directly) |
| 02-05 voice-capture (AGT-02) | `embedBatch`, `findCandidates`, `hasProjectCooccurrence`, `resolveStage` |
| 02-06 entity-resolver (AGT-03 / ENT-09) | all of `@kos/resolver` — primary consumer |
| 02-07 bulk-import-kontakter (ENT-05) | `embedBatch`, `buildEntityEmbedText`, `findCandidates` |
| 02-08 bulk-import-granola-gmail (ENT-06) | `embedBatch`, `buildEntityEmbedText`, `findCandidates` |

All these Lambdas will write 1024-dim vectors that require Task 3 to have been applied to live RDS. Plans 02-04+ must gate on Kevin's confirmation that migration 0003+0004 ran successfully.

## Commits

| Hash | Message |
|------|---------|
| `575b981` | feat(02-03): resolver library with embed + candidates + hybridScore tests |
| `eae314c` | feat(02-03): migrations 0003 (1536→1024 + embedding_model) + 0004 (pg_trgm + HNSW recreate) |
| `2c634a6` | feat(02-03): Azure AI Search index dimensions 1536 → 1024 (Cohere D-06) |

## Self-Check: PASSED

All 17 created/modified files verified on disk. All 3 commits (`575b981`, `eae314c`, `2c634a6`) verified in `git log`. Task 3 (BLOCKING live migration) explicitly documented as pending operator action with exact runbook commands — the orchestrator should relay this checkpoint to Kevin.
