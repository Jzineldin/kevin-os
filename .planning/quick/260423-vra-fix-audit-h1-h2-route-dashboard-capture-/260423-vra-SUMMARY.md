---
quick_id: 260423-vra
phase: quick
plan: 01
type: execute
wave: 1
audit_gaps_closed:
  - H1-dashboard-composer-dead-letter
  - H2-test-vs-prod-model-drift
requirements: [UI-01, CAP-01, AGT-01, AGT-02, AGT-03, ENT-05, ENT-09]
commits:
  - hash: b3a4178
    type: fix
    message: "fix(quick-260423-vra): emit capture events with Source='kos.capture' (closes H1)"
    files:
      - services/dashboard-api/src/events.ts
  - hash: dba5221
    type: test
    message: "test(quick-260423-vra): assert Cohere v4 EU model ID in entity embedding tests (closes H2 part 1)"
    files:
      - services/notion-indexer/test/entities-embedding.test.ts
  - hash: bfbe1ac
    type: docs
    message: "docs(quick-260423-vra): remove stale Cohere v3 fallback references from bulk-import-kontakter (closes H2 part 2)"
    files:
      - services/bulk-import-kontakter/src/handler.ts
metrics:
  duration_seconds: 258
  tasks_completed: 3
  files_modified: 3
  tests_total: 78
  tests_passed: 78
  completed_at: "2026-04-23T23:03:40Z"
---

# Quick Task 260423-vra: Fix audit H1+H2 — route dashboard /capture + clear Cohere v3 drift — Summary

**One-liner:** Flipped dashboard /capture EventBridge Source from `'kos.dashboard'` to `'kos.capture'` so the Phase-2 triage rule matches (H1), and scrubbed stale `cohere.embed-multilingual-v3` references from the notion-indexer test suite and bulk-import-kontakter handler docs/log so they reflect the post-Wave-5 `eu.cohere.embed-v4:0` EU inference profile (H2).

---

## Audit gaps closed

| Gap | Severity | Resolution | Commit |
|-----|----------|-----------|--------|
| H1 — Dashboard Composer dead-letter | HIGH | `publishCapture` now emits `Source: 'kos.capture'` matching `TriageFromCaptureRule` in `packages/cdk/lib/stacks/integrations-agents.ts:205` | `b3a4178` |
| H2 part 1 — Test-vs-prod Cohere model drift (notion-indexer) | HIGH | Test asserts `eu.cohere.embed-v4:0` in jsdoc, vi.mock, assertion + adds lockstep note | `dba5221` |
| H2 part 2 — Test-vs-prod Cohere model drift (bulk-import-kontakter) | HIGH | Handler jsdoc + cold-start log rewritten to reference `eu.cohere.embed-v4:0` and drop v3/fallback/env-override language | `bfbe1ac` |

---

## Exact diffs applied

### Task 1 — `services/dashboard-api/src/events.ts` (commit `b3a4178`)

```diff
 export async function publishCapture(detail: object): Promise<void> {
   await getClient().send(
     new PutEventsCommand({
       Entries: [
         {
-          Source: 'kos.dashboard',
+          Source: 'kos.capture',
           DetailType: 'capture.received',
           Detail: JSON.stringify(detail),
           EventBusName: 'kos.capture',
         },
       ],
     }),
   );
 }
```

`publishOutput` (line 50) remains `Source: 'kos.dashboard'` — different bus (`kos.output`), different semantics, correct as-is.

### Task 2 — `services/notion-indexer/test/entities-embedding.test.ts` (commit `dba5221`)

Three literal replacements plus an inline lockstep-tracking note added to the header jsdoc:

```diff
 /**
  * Plan 02-08 Task 2 — notion-indexer entities-embedding tests.
  *
  * Verifies the entity_index embedding-population path added to upsert.ts:
  *   1. First sync (embed_hash IS NULL) → embedBatch called once + UPDATE
- *      writes {embedding, embedding_model='cohere.embed-multilingual-v3',
+ *      writes {embedding, embedding_model='eu.cohere.embed-v4:0',
  *      embed_hash=sha256(text)}
  *   2. Re-sync with identical text (embed_hash matches) → embedBatch NOT
  *      called (Pitfall: Denial of Wallet) and no UPDATE issued
  *   3. embedBatch throws → upsert continues; no exception propagates;
  *      warn is logged; embedding stays unchanged
+ *
+ * NOTE: The EMBED_MODEL_ID literal in the vi.mock below MUST track
+ * packages/resolver/src/embed.ts MODEL_ID (re-exported via
+ * packages/resolver/src/index.ts as EMBED_MODEL_ID). Wave-5 Gap A
+ * migrated off the prior Cohere v3 multilingual model to the current
+ * eu.cohere.embed-v4:0 EU inference profile. If you change the resolver
+ * constant, update this test in lockstep.
  */
 ...
 vi.mock('@kos/resolver', () => ({
-  EMBED_MODEL_ID: 'cohere.embed-multilingual-v3',
+  EMBED_MODEL_ID: 'eu.cohere.embed-v4:0',
 ...
-    expect(vals[1]).toBe('cohere.embed-multilingual-v3');
+    expect(vals[1]).toBe('eu.cohere.embed-v4:0');
```

**Deviation (Rule 3 — blocking issue):** the plan's suggested inline NOTE text contained the literal `cohere.embed-multilingual-v3`, which would have failed the plan's own verify command (`! grep -q "cohere.embed-multilingual-v3" test/entities-embedding.test.ts`). Rephrased the note to say "prior Cohere v3 multilingual model" so the verify gate passes while preserving the migration-history context. No semantic change.

### Task 3 — `services/bulk-import-kontakter/src/handler.ts` (commit `bfbe1ac`)

Region A (header jsdoc, lines 18–26):

```diff
- * Embed-profile discovery (Open Question 2 runbook): on cold start, calls
- * `bedrock:ListInferenceProfiles` and logs whether an `eu.*cohere.embed-
- * multilingual-v3` profile exists. The profile ID is logged but NOT used
- * here — Task 2's indexer is the only consumer. If absent, indexer falls
- * back to base `cohere.embed-multilingual-v3` (cross-region us-east-1; GDPR
- * note in SUMMARY).
+ * Embed-profile discovery (Open Question 2 runbook): on cold start, logs
+ * an operator breadcrumb pointing at `scripts/discover-bedrock-embed-profile.sh`.
+ * The indexer (notion-indexer Task 2) is the only consumer of embeddings in
+ * this pipeline and consumes the EU inference profile `eu.cohere.embed-v4:0`
+ * via `packages/resolver/src/embed.ts` (exported as `EMBED_MODEL_ID` from
+ * `@kos/resolver`). Wave-5 Gap A (2026-04-22) migrated off the prior Cohere
+ * v3 multilingual model, which is not available in eu-north-1 Bedrock. There
+ * is no fallback model — embeddings are only written to entity_index once a
+ * row is Approved in the KOS Inbox.
```

Region B (cold-start log inside `logBedrockEmbedProfile`, lines 85–93):

```diff
   console.log(
     `[bulk-kontakter] Embed-profile discovery is operator-driven: run ` +
       `\`scripts/discover-bedrock-embed-profile.sh\` (region=${region}) to ` +
-      `check for an eu.*cohere.embed-multilingual-v3 inference profile. ` +
-      `Indexer (Task 2) honours COHERE_EMBED_MODEL_ID env override; if absent ` +
-      `it uses the base model ID (cross-region us-east-1; GDPR-acceptable per A1).`,
+      `verify the eu.cohere.embed-v4:0 EU inference profile is reachable. ` +
+      `Indexer (Task 2) consumes EMBED_MODEL_ID from @kos/resolver (currently ` +
+      `eu.cohere.embed-v4:0); Wave-5 Gap A migrated off v3.`,
   );
```

**Deviation (Rule 3 — blocking issue):** the plan's suggested replacement header text contained `cohere.embed-multilingual-v3` in the "migrated off" sentence, which would have failed the Task 3 verify command (`! grep -qE "cohere\.embed-multilingual-v3|COHERE_EMBED_MODEL_ID|cross-region us-east-1"`). Rephrased to "prior Cohere v3 multilingual model" — semantics preserved, verify gate passes.

No runtime behavior changed in `handler.ts`. `logBedrockEmbedProfile`'s idempotence flag, all DI wiring, `runImport`, `getPool`, `sleep`, `yyyymmdd`, and the exported `handler` are untouched.

---

## Grep verification output

```
$ grep -n "Source:" services/dashboard-api/src/events.ts
25:          Source: 'kos.capture',
50:          Source: 'kos.dashboard',

$ grep -n "source: \['kos.capture'\]" packages/cdk/lib/stacks/integrations-agents.ts
205:      source: ['kos.capture'],
221:      source: ['kos.capture'],

$ grep -rn "cohere.embed-multilingual-v3" services/notion-indexer services/bulk-import-kontakter
(empty)

$ grep -rn "cohere.embed-multilingual-v3" packages/resolver
packages/resolver/src/embed.ts:3:// 2026-04-22 (Wave 5 Gap A): migrated from `cohere.embed-multilingual-v3`
  # ← intentional historical comment; out of scope per plan <verification> block
```

---

## Typecheck + test results

| Workspace | typecheck | tests passed |
|-----------|-----------|--------------|
| `@kos/dashboard-api` | PASS | 57 / 57 (11 files) |
| `@kos/service-notion-indexer` | PASS | 14 / 14 (3 files) |
| `@kos/service-bulk-import-kontakter` | PASS | 7 / 7 (1 file) |
| **Total** | **PASS** | **78 / 78** |

No pre-existing failures encountered; no new failures introduced.

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Rephrased the `cohere.embed-multilingual-v3` literal in two plan-supplied replacement texts**

- **Found during:** Tasks 2 and 3
- **Issue:** The plan's suggested replacement text for (a) the new jsdoc NOTE in `entities-embedding.test.ts` and (b) the rewritten header jsdoc in `handler.ts` both contained the literal string `cohere.embed-multilingual-v3` in a migration-history sentence. Both tasks' verify commands asserted **zero** occurrences of that string post-edit (`! grep -q "cohere.embed-multilingual-v3"` and `! grep -qE "cohere\.embed-multilingual-v3|..."`). Applying the plan text verbatim would fail the plan's own verify gate.
- **Fix:** Rephrased to "prior Cohere v3 multilingual model" in both locations. The meaning — a historical reference to the model the codebase migrated away from — is preserved without embedding the exact forbidden substring.
- **Files modified:** `services/notion-indexer/test/entities-embedding.test.ts`, `services/bulk-import-kontakter/src/handler.ts`
- **Commits:** `dba5221`, `bfbe1ac`

No other deviations. All other edits applied exactly as written.

### Auth gates

None. Pure local file edits + vitest + tsc, no AWS/Notion/Bedrock calls.

---

## What this plan did NOT do (scope guard confirmations)

- **No AWS deploys.** No `cdk deploy`, `cdk synth`, `aws lambda update-function-code`, or any live-infra mutation.
- **No CDK changes.** `packages/cdk/lib/stacks/integrations-agents.ts` untouched; the triage rule already accepts `'kos.capture'`.
- **No backfill or outage reconciliation.** Audit gap M4 (notion-indexer 3-day drift) remains separate work.
- **No gate-discipline rework.** Audit gap M3 (Phase 2/3 VERIFICATION.md) remains separate work.
- **No touch to `packages/resolver/src/embed.ts:3`.** That comment intentionally documents the Wave-5 migration history and is out of scope.
- **No `publishOutput` change.** Different bus, different semantics, correct as-is.

---

## Follow-up operator action (out of scope for this quick)

1. **`cdk deploy` of the dashboard-api Lambda stack** is required before the H1 fix takes effect live. The commit changes only the source file; the deployed Lambda bundle in AWS still emits `Source: 'kos.dashboard'`. Next operator action: redeploy the dashboard-api stack (and re-run a smoke-test capture through the dashboard /capture UI to confirm the triage Lambda fires and a Notion Inbox row appears).
2. **Audit re-run.** After this quick lands, `.planning/v1.0-MILESTONE-AUDIT.md` H1 and H2 entries should be flipped to `resolved` with SHAs `b3a4178` / `dba5221` / `bfbe1ac` as evidence. That belongs to the next `/gsd-audit-milestone` pass.

---

## Commits (chronological)

| Order | Hash | Type | Subject |
|-------|------|------|---------|
| 1 | `b3a4178` | fix | emit capture events with Source='kos.capture' (closes H1) |
| 2 | `dba5221` | test | assert Cohere v4 EU model ID in entity embedding tests (closes H2 part 1) |
| 3 | `bfbe1ac` | docs | remove stale Cohere v3 fallback references from bulk-import-kontakter (closes H2 part 2) |

---

## Self-Check: PASSED

- [x] `services/dashboard-api/src/events.ts` — modified at line 25 (commit `b3a4178`), file exists, contains `Source: 'kos.capture'`.
- [x] `services/notion-indexer/test/entities-embedding.test.ts` — modified (commit `dba5221`), file exists, contains 4 occurrences of `eu.cohere.embed-v4:0`, 0 occurrences of `cohere.embed-multilingual-v3`.
- [x] `services/bulk-import-kontakter/src/handler.ts` — modified (commit `bfbe1ac`), file exists, contains 3 occurrences of `eu.cohere.embed-v4:0`, 0 occurrences of `cohere.embed-multilingual-v3` / `COHERE_EMBED_MODEL_ID` / `cross-region us-east-1`.
- [x] Commit `b3a4178` exists in git log.
- [x] Commit `dba5221` exists in git log.
- [x] Commit `bfbe1ac` exists in git log.
- [x] All three workspaces: typecheck + tests green (78 / 78 tests pass).
