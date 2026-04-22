# Deferred Items — Phase 02

## From Plan 02-00 (Wave 0 Scaffolding)

### Pre-existing test failure: transcribe-vocab-deploy

- **Source:** `services/transcribe-vocab-deploy/test/handler.test.ts` — test "on Create: downloads seed, uploads cleaned content, calls CreateVocabulary with sv-SE, polls to READY"
- **Nature:** Expected `s3://kos-blobs-bucket/vocab/sv-se-v1.txt` but handler now emits `s3://cdk-asset-bucket/vocab-cleaned/sv-se-v1.txt`
- **Root cause:** Phase 01 commit `1c009f3` ("fix(01): route vocab through asset bucket + Azure DELETE echo") changed the S3 path but did not update the test fixture
- **Scope:** Pre-existing; not caused by Plan 02-00 changes (this plan only added new files under `packages/resolver`, `packages/test-fixtures`, `services/_shared`, 8 new `services/*` dirs, and CDK secret shells — none touch transcribe-vocab-deploy)
- **Action:** Owner of that Phase 01 plan should reconcile the test with the new asset-bucket-based path. Out of scope for Wave 0 Phase 02 scaffolding.

### Peer-dependency warning: zod

- **Source:** `pnpm install` emits `unmet peer zod@^4.0.0: found 3.23.8` for `@anthropic-ai/claude-agent-sdk@0.2.117` and its transitive `@modelcontextprotocol/sdk`
- **Scope:** Monorepo-wide pinning — Phase 01 locked zod at 3.23.8 across all services
- **Action:** Plan a dedicated zod upgrade (3.x → 4.x) before Plan 02-04 (triage agent) runs real Claude Agent SDK calls, or pin the SDK to an older compatible release. Not blocking for Wave 0 — typecheck passes, unit-test scaffolds pass.

## From Plan 02-10 (Observability)

### Pre-existing typecheck failure: telegram-bot test/handler.test.ts

- **Source:** `services/telegram-bot/test/handler.test.ts` line 2: `Cannot find module '@kos/test-fixtures' or its corresponding type declarations.`
- **Scope:** Reproducible on the Wave-3 base commit (4bf7c16) BEFORE any Plan 02-10 edits — verified via `git stash` then re-typecheck
- **Action:** Owner of telegram-bot test setup should add the workspace symlink or reinstall deps. Out of scope for Plan 02-10 — observability changes do not touch test-fixtures wiring.

### Pre-existing typecheck failure: notion-indexer test/entities-embedding.test.ts

- **Source:** `services/notion-indexer/test/entities-embedding.test.ts` lines 78-79: `Object is possibly 'undefined'.`
- **Scope:** Reproducible on the Wave-3 base commit (4bf7c16) BEFORE any Plan 02-10 edits — verified via `git stash` then re-typecheck
- **Action:** Owner of notion-indexer should add `?.` or non-null assertion in the test. Out of scope for Plan 02-10.

