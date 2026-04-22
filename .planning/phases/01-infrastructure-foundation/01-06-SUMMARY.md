---
phase: 01-infrastructure-foundation
plan: 06
subsystem: transcribe-vocabulary
tags: [infrastructure, transcribe, sv-SE, cdk, custom-resource]
requires: [01-00, 01-01, 01-02]
provides:
  - AWS Transcribe custom vocabulary `kos-sv-se-v1` (sv-SE, phrase-only)
  - `wireTranscribeVocab()` helper for IntegrationsStack composition
  - Seed vocab file `vocab/sv-se-v1.txt` (26 Kevin-specific phrases)
  - `services/transcribe-vocab-deploy` Lambda package
  - `scripts/verify-transcribe-vocab.sh` Gate verification
affects: [packages/cdk, services, vocab]
tech-stack:
  added:
    - "@aws-sdk/client-transcribe@3.691.0"
    - "@aws-sdk/client-s3@3.691.0 (already transitively present)"
  patterns:
    - "CDK Asset construct for file bundling (Windows-safe, ESM-clean)"
    - "CustomResource + Provider framework for AWS API side-effects"
    - "contentHash fingerprinting via vocabAsset.assetHash for Update detection"
    - "Archive-not-delete on CloudFormation Delete (preserve Phase 2 consumers)"
    - "Create-or-Update probe via GetVocabulary (BadRequestException catch)"
key-files:
  created:
    - path: vocab/sv-se-v1.txt
      purpose: "Seed phrase-only vocabulary — 26 Kevin-specific entities + Swedish finance terms"
    - path: services/transcribe-vocab-deploy/package.json
      purpose: "@kos/service-transcribe-vocab-deploy workspace package"
    - path: services/transcribe-vocab-deploy/tsconfig.json
      purpose: "TS config extending root base"
    - path: services/transcribe-vocab-deploy/vitest.config.ts
      purpose: "Vitest config (30s timeout, node env)"
    - path: services/transcribe-vocab-deploy/src/handler.ts
      purpose: "CloudFormation CustomResource Lambda handler (create/update/archive/poll)"
    - path: services/transcribe-vocab-deploy/test/handler.test.ts
      purpose: "7 unit tests: sv-SE, archive-not-delete, FAILED throw, 5-min deadline, comment stripping"
    - path: packages/cdk/lib/stacks/integrations-transcribe.ts
      purpose: "wireTranscribeVocab() helper — CDK wiring to be composed into IntegrationsStack"
    - path: packages/cdk/test/integrations-stack-vocab.test.ts
      purpose: "5 synth-level tests: env vars, IAM, CustomResource contentHash, no cp -r"
    - path: scripts/verify-transcribe-vocab.sh
      purpose: "Gate script — asserts vocabulary state READY + LanguageCode sv-SE"
  modified:
    - path: pnpm-lock.yaml
      purpose: "Lockfile updates for new workspace package"
decisions:
  - "Put wiring in integrations-transcribe.ts helper (not integrations-stack.ts) to avoid Wave 3 merge collisions with Plans 04 + 05"
  - "Strip `#` comments + blank lines before upload — keeps the seed file human-readable while giving Transcribe a pure phrase list"
  - "Archive-not-delete on stack Delete — Phase 2 voice transcription consumes this vocabulary by name; accidental stack destruction shouldn't ablate it"
  - "Use CDK Asset (not bundling.command with shell copy) — Windows dev hosts don't have bash cp available during synth"
  - "IAM resource:* for transcribe:*Vocabulary — Transcribe vocabulary ARNs are not scope-restrictable at CreateVocabulary time; the Lambda role itself is narrowly scoped"
  - "contentHash = vocabAsset.assetHash — deterministic over file contents; edit → rehash → CloudFormation diff → Lambda Update event → UpdateVocabulary"
metrics:
  completed: 2026-04-22
  duration: ~35min
  tasks_completed: 2
  tasks_total: 2
  files_created: 9
  files_modified: 1
  commits: 2
  tests_added: 12
---

# Phase 01 Plan 06: Transcribe sv-SE Custom Vocabulary Summary

Phrase-only AWS Transcribe custom vocabulary `kos-sv-se-v1` (26 Kevin-specific entities + Swedish finance terms) deployed via CloudFormation CustomResource with archive-not-delete semantics and content-hash-driven Update detection.

## Context

Plan 01-06 delivers requirement **INF-08** — AWS Transcribe custom vocabulary for Swedish audio transcription in Phase 2. Per RESEARCH Pitfall 7, IPA and SoundsLike columns are deprecated/silently-ignored for Swedish, so the only accuracy lever available is a phrase-only vocabulary with hyphen-bound multi-word entities (`Tale-Forge`, `Tale-Forge-AB`). This plan ships the mechanism plus a seed file; Kevin can edit `vocab/sv-se-v1.txt` post-Phase-1 and redeploy to refresh the vocabulary without CDK code changes.

## What Was Built

### Task 1 — Seed vocab + deploy Lambda + verification script (commit `1f283db`)

**`vocab/sv-se-v1.txt`** — 26 active phrases spread across:

- **People (5):** Kevin, Damien, Christina, Marcus, Monika
- **Companies / orgs (4):** Tale-Forge, Tale-Forge-AB, Outbehaving, Almi
- **Finance / legal Swedish (6):** Bolag, konvertibellån, kapitalrunda, aktieägaravtal, ESOP, GDPR
- **AI / Anthropic (4):** Claude, Sonnet, Haiku, Bedrock
- **Data / infra (2):** Postgres, pgvector
- **Capture surfaces (5):** Granola, Notion, Telegram, WhatsApp, LinkedIn

Counts: **26 active phrases, 9 Kevin-specific entity names** (people + companies + Almi).

The file is documentation-rich (headers + per-group comments) — the deploy Lambda strips `#` lines and blanks before uploading the cleaned content to the canonical S3 key.

**`services/transcribe-vocab-deploy/`** — CloudFormation CustomResource Lambda:

- Reads seed from CDK Asset S3 (env vars `VOCAB_SEED_BUCKET` / `VOCAB_SEED_KEY`).
- Strips comments + blanks (CRLF-safe — tested against Windows line endings).
- Re-uploads cleaned content to canonical `VOCAB_BUCKET` / `VOCAB_S3_KEY` so Kevin can also mutate it out-of-band via `aws s3 cp` without redeploy.
- Probes for existing vocabulary via `GetVocabularyCommand`; catches `BadRequestException` / `NotFoundException` as "doesn't exist yet".
- Routes to `CreateVocabulary` or `UpdateVocabulary` with `LanguageCode: sv-SE` explicitly set. Does **not** use Transcribe auto-language-id (Anti-Pattern per RESEARCH line 608 — Swedish not in auto-id matrix).
- Polls `GetVocabulary` every 10s until `READY` (success) or `FAILED` (throws with `FailureReason`). Hard deadline: 5 minutes.
- Delete handler returns `PhysicalResourceId` without calling `DeleteVocabulary` — **archive-not-delete** preserves the vocabulary through stack churn so Phase 2 voice consumers never lose it.

**7 unit tests** (all passing):

1. `stripCommentsAndBlanks`: drops `#` lines + blanks, preserves phrases
2. `stripCommentsAndBlanks`: handles Windows CRLF
3. Delete returns PhysicalResourceId without calling Transcribe or S3
4. Create: downloads seed → uploads cleaned content → CreateVocabulary with sv-SE → polls to READY
5. Update: detects existing vocabulary → UpdateVocabulary (not Create)
6. FAILED state → throws with failure reason
7. 5-minute deadline exceeded → throws timeout error

**`scripts/verify-transcribe-vocab.sh`** — bash gate script reading region from `scripts/.transcribe-region` (Wave 0 preflight output = `eu-north-1`). Calls `aws transcribe get-vocabulary` and asserts state=READY + LanguageCode=sv-SE.

### Task 2 — CDK wiring as composable helper (commit `bf38336`)

**Coordination note from orchestrator:** Wave 3 runs Plans 04, 05, 06 in parallel, all extending IntegrationsStack. To avoid merge collisions, I put my wiring in a helper module `packages/cdk/lib/stacks/integrations-transcribe.ts` (exported as `wireTranscribeVocab(scope, props)`) instead of editing a not-yet-existing `integrations-stack.ts`. The Plan 04 owner composes `wireTranscribeVocab()` into their IntegrationsStack.

**`integrations-transcribe.ts`** builds:

1. A CDK `Asset` bundling `vocab/sv-se-v1.txt` at synth time. Windows-safe — esbuild bundles the Lambda, CDK handles the Asset upload; no shell copy commands involved anywhere.
2. A `KosLambda` (ARM64 Node 22.x, log retention 30d) with `timeout=10min`, `memory=512MB`, and environment variables `TRANSCRIBE_REGION`, `VOCAB_BUCKET`, `VOCAB_S3_KEY`, `VOCAB_SEED_BUCKET`, `VOCAB_SEED_KEY`.
3. Grants: `vocabAsset.grantRead(fn)`, `blobsBucket.grantReadWrite(fn)`, inline policy with `transcribe:{Create,Update,Get}Vocabulary`.
4. A `custom-resources.Provider` with `onEventHandler: deployFn`, feeding a `CustomResource` whose `properties.contentHash = vocabAsset.assetHash`.

The content-hash pattern gives us seamless change detection: edit `vocab/sv-se-v1.txt` → Asset re-hashes → CloudFormation diffs the `contentHash` property → CustomResource receives `RequestType=Update` → Lambda routes to `UpdateVocabulary` → polls to READY.

Pure ESM: uses `fileURLToPath(import.meta.url)` for `__dirname`; no `require()` calls.

**5 synth-level tests** (all passing):

1. Deploy Lambda carries `TRANSCRIBE_REGION=eu-north-1`, `VOCAB_S3_KEY=vocab/sv-se-v1.txt`, plus CloudFormation-resolved refs for `VOCAB_BUCKET` / `VOCAB_SEED_*`.
2. IAM policy contains all three Transcribe vocabulary actions.
3. A CloudFormation resource exists with `contentHash` property + `ServiceToken` (non-empty `contentHash` string > 8 chars).
4. At least 2 `Lambda::Function` resources emitted (user Lambda + Provider framework Lambda).
5. Negative assertion — synthesized template contains no `cp -r` string anywhere.

## Verification

### Automated (passing at time of commit)

- `pnpm --filter @kos/service-transcribe-vocab-deploy typecheck` — passes
- `pnpm --filter @kos/service-transcribe-vocab-deploy test -- --run` — 7/7 pass
- `pnpm --filter @kos/cdk typecheck` — passes
- `pnpm --filter @kos/cdk test -- --run` — 27/27 pass (6 test files)
- `cd packages/cdk && npx cdk synth --quiet` — succeeds on KosNetwork / KosEvents / KosData (IntegrationsStack composition deferred to Plan 04 owner)

### Deferred to Operator (live AWS — requires deploy)

1. Plan 04 owner composes `wireTranscribeVocab()` into their `IntegrationsStack` and wires `transcribeRegion` prop into `bin/kos.ts` (reading from `scripts/.transcribe-region`).
2. `cd packages/cdk && cdk deploy KosIntegrations` — provisions the Asset, deploys the Lambda, triggers the CustomResource → CreateVocabulary.
3. `bash scripts/verify-transcribe-vocab.sh` — confirms vocabulary state READY + LanguageCode sv-SE.

## Chosen Region

`eu-north-1` (from `scripts/.transcribe-region`, resolved by Wave 0 preflight — Transcribe sv-SE availability confirmed there via live CLI check).

## Seed Term Counts

- **Total active phrases:** 26
- **Kevin-specific entities (people + Kevin's companies + Almi):** 9
- **Domain vocabulary (Swedish finance/legal):** 6
- **Tech/tooling terms (commonly code-switched in Kevin's voice memos):** 11

## Time to READY (observed on first deploy)

**Not yet observed** — deploy is deferred to Plan 04 owner (Wave 3 coordination). Plan budget is 5 minutes; CloudWatch Logs from the custom-resource Lambda will record actual poll duration. Empirically AWS Transcribe vocabulary transitions PENDING→READY in 30–90 seconds for phrase-only vocabularies of this size.

## Deviations from Plan

### [Rule 3 - Blocking] Could not edit `integrations-stack.ts` / `bin/kos.ts`

- **Found during:** Task 2 prep
- **Issue:** The plan's literal action says "Extend `packages/cdk/lib/stacks/integrations-stack.ts`" and "Update `packages/cdk/bin/kos.ts` to pass new props", but neither change is safe while Plans 04 + 05 are running in parallel on the same Wave. The `<coordination_note>` in the orchestrator prompt explicitly instructed: "Put your Transcribe wiring in `packages/cdk/lib/stacks/integrations-transcribe.ts` helper so it doesn't collide with Plans 04 and 05 on `integrations-stack.ts`."
- **Fix:** Built `integrations-transcribe.ts` as a composable helper module exporting `wireTranscribeVocab(scope, props)`. The helper is fully self-contained and synth-tested in isolation via a minimal stack in `integrations-stack-vocab.test.ts`. Plan 04's owner composes it into their IntegrationsStack with a single function call; wiring `bin/kos.ts` with `transcribeRegion` is deferred to the same owner to avoid a three-way merge.
- **Files modified:** `packages/cdk/lib/stacks/integrations-transcribe.ts` (created, not `integrations-stack.ts`)
- **Commit:** `bf38336`

### [Rule 2 - Missing functionality] Comment / blank-line stripping in the deploy Lambda

- **Found during:** Task 1 (seed file authoring)
- **Issue:** The plan's seed file example is a bare phrase list. For Kevin's long-term maintainability I checked in a documented seed file with `#` headers and per-group section comments. AWS Transcribe expects one phrase per line with no comment syntax, so uploading the raw file would cause Transcribe to treat `# People (Kevin's network)` as a literal phrase.
- **Fix:** Added `stripCommentsAndBlanks()` to the handler (tested with CRLF-safe behavior); Lambda strips comments during upload. Seed file stays documentation-rich; canonical S3 object is pure phrase lines.
- **Commit:** `1f283db`

## Threat Model Mitigations Applied

| Threat ID | Mitigation |
|-----------|------------|
| T-01-VOCAB-01 (Integrity — malformed vocab) | Lambda polls for READY with 5-min deadline; throws with `FailureReason` on FAILED; CloudFormation surfaces the error to operator |
| T-01-VOCAB-02 (Info Disclosure — personal names) | Accepted per plan disposition (Kevin's own network, vocabulary referenced by name not transmitted externally) |
| T-01-VOCAB-03 (Availability — region support) | Region read from `scripts/.transcribe-region` which Wave 0 preflight validated against live `aws transcribe get-vocabulary-filter` |

## Known Stubs

**None.** All files deliver production behavior; the only deferred piece is the IntegrationsStack composition which is Plan 04's responsibility per Wave 3 coordination.

## Integration Points

- **Plan 04 (Azure bootstrap + IntegrationsStack creation):** compose `wireTranscribeVocab(this, { blobsBucket: props.blobsBucket, transcribeRegion: props.transcribeRegion })` into IntegrationsStack constructor.
- **Plan 04 (`bin/kos.ts` wiring):** add `transcribeRegion: fs.readFileSync('scripts/.transcribe-region', 'utf8').trim()` to IntegrationsStack props.
- **Phase 2 (voice transcription consumer):** reference vocabulary by name `kos-sv-se-v1` at `StartTranscriptionJob` time via `Settings.VocabularyName`.

## Self-Check: PASSED

Verified:

- `vocab/sv-se-v1.txt` — exists, 26 active phrases, contains Tale-Forge + Almi + konvertibellån
- `services/transcribe-vocab-deploy/src/handler.ts` — exists, sv-SE literal, CreateVocabulary + UpdateVocabulary, archive-not-delete preserved, no `IdentifyLanguage`
- `packages/cdk/lib/stacks/integrations-transcribe.ts` — exists, no `require()`, no `cp -r`, uses `aws-s3-assets` Asset
- `packages/cdk/test/integrations-stack-vocab.test.ts` — 5/5 pass
- `services/transcribe-vocab-deploy/test/handler.test.ts` — 7/7 pass
- All CDK tests — 27/27 pass
- `scripts/verify-transcribe-vocab.sh` — executable bit set (+x)
- Commit `1f283db` exists in history
- Commit `bf38336` exists in history
