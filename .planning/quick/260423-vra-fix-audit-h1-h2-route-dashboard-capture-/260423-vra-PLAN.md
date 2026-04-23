---
quick_id: 260423-vra
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - services/dashboard-api/src/events.ts
  - services/notion-indexer/test/entities-embedding.test.ts
  - services/bulk-import-kontakter/src/handler.ts
autonomous: true
requirements: [UI-01, CAP-01, AGT-01, AGT-02, AGT-03, ENT-05, ENT-09]
audit_gaps_closed:
  - H1-dashboard-composer-dead-letter
  - H2-test-vs-prod-model-drift

must_haves:
  truths:
    - "Dashboard /capture Server Action emits EventBridge detail with Source='kos.capture' (not 'kos.dashboard') so the existing triage rule matches and triage Lambda fires."
    - "notion-indexer entities-embedding test suite asserts the true prod embedding model ID (eu.cohere.embed-v4:0) — tests pass against the real @kos/resolver EMBED_MODEL_ID export."
    - "bulk-import-kontakter handler.ts documentation + runtime log message reflect the post-Wave-5 Cohere v4 EU inference profile — no stale v3 fallback language."
    - "No file in the repo hardcodes a Cohere model ID string for embedding. packages/resolver/src/embed.ts (MODEL_ID, re-exported via index.ts as EMBED_MODEL_ID) remains the single source of truth."
  artifacts:
    - path: "services/dashboard-api/src/events.ts"
      provides: "publishCapture emitting Source='kos.capture' to kos.capture bus (publishOutput unchanged)"
      contains: "Source: 'kos.capture'"
    - path: "services/notion-indexer/test/entities-embedding.test.ts"
      provides: "entity-embedding test with v4 model assertion"
      contains: "eu.cohere.embed-v4:0"
    - path: "services/bulk-import-kontakter/src/handler.ts"
      provides: "bulk-import handler with accurate v4 documentation + log"
      contains: "eu.cohere.embed-v4:0"
  key_links:
    - from: "services/dashboard-api/src/events.ts (publishCapture)"
      to: "packages/cdk/lib/stacks/integrations-agents.ts (TriageFromCaptureRule, line 205)"
      via: "EventBridge Source='kos.capture' matches rule source filter"
      pattern: "Source: 'kos.capture'"
    - from: "services/notion-indexer/src/upsert.ts"
      to: "packages/resolver/src/index.ts (EMBED_MODEL_ID re-export)"
      via: "import { EMBED_MODEL_ID } from '@kos/resolver'"
      pattern: "EMBED_MODEL_ID"
---

<objective>
Close two HIGH-severity integration gaps from the v1.0 milestone audit:

- **H1 — Dashboard Composer dead-letter**: dashboard /capture Server Action currently emits EventBridge events with `Source: 'kos.dashboard'`, but the Phase 2 triage rule filters on `source: ['kos.capture']`. Result: text captures enter EventBridge, drop silently, no triage, no Notion row, no SSE `capture_ack`. Fix: change the `publishCapture` emitted `Source` string to `'kos.capture'` — preserves canonical source semantics (every capture enters via `kos.capture` regardless of channel: telegram, dashboard, email, etc.). `publishOutput` is on a different bus (`kos.output`) and stays `'kos.dashboard'`.

- **H2 — Test-vs-prod Cohere model drift**: Wave-5 migrated prod embedding from `cohere.embed-multilingual-v3` to `eu.cohere.embed-v4:0` (the `MODEL_ID` const in `packages/resolver/src/embed.ts`, re-exported as `EMBED_MODEL_ID` from the package index). Two stale references remain:
  1. `services/notion-indexer/test/entities-embedding.test.ts` still asserts the v3 model ID (lines 20 + 88, plus header comment on line 6) — tests will fail against the true constant.
  2. `services/bulk-import-kontakter/src/handler.ts` has stale v3 fallback language in the header jsdoc block (lines 19–23) and in the runtime cold-start log message (lines 88–90). No hardcoded string in code — just misleading documentation that contradicts the runbook.

Purpose: unblock Phase 3 Composer wiring (H1) and restore CI green + runbook accuracy (H2). Both are pure local edits — no AWS mutations, no deploys.

Output: 3 file edits, one commit per task, all verify commands green.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/v1.0-MILESTONE-AUDIT.md

<interfaces>
<!-- Verified by grep against the live tree at plan time (2026-04-23). -->
<!-- Executor should trust these and not re-explore. -->

From services/dashboard-api/src/events.ts (VERIFIED):
```typescript
// Current state — the broken line is Source on publishCapture, NOT publishOutput.
export async function publishCapture(detail: object): Promise<void> {
  await getClient().send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'kos.dashboard',        // ← LINE 25 — must change to 'kos.capture'
          DetailType: 'capture.received',
          Detail: JSON.stringify(detail),
          EventBusName: 'kos.capture',
        },
      ],
    }),
  );
}

// DO NOT TOUCH publishOutput (line 50 uses Source: 'kos.dashboard' for kos.output bus).
// That is a different bus (SSE fan-out) with different semantics — leaving it alone is correct.
```

From packages/cdk/lib/stacks/integrations-agents.ts (VERIFIED, the rule we need to satisfy):
```typescript
// Line 202-216: TriageFromCaptureRule — the rule we need the dashboard Source to match.
const triageRule = new Rule(scope, 'TriageFromCaptureRule', {
  eventBus: p.captureBus,
  eventPattern: {
    source: ['kos.capture'],                  // ← Source filter
    detailType: ['capture.received'],
    detail: { kind: ['text'] },
  },
  ...
});
```

From packages/resolver/src/embed.ts (VERIFIED, single source of truth):
```typescript
// Line 9 — the canonical constant.
export const MODEL_ID = 'eu.cohere.embed-v4:0';
```

From packages/resolver/src/index.ts (VERIFIED, public re-export):
```typescript
// Line 11 — public name consumers import as.
export { MODEL_ID as EMBED_MODEL_ID, ... } from './embed.js';
```

From services/notion-indexer/src/upsert.ts (VERIFIED, correctly imports via package boundary — no fix needed):
```typescript
// Line 28
import { ..., EMBED_MODEL_ID, ... } from '@kos/resolver';
// Line 186
[vecLiteral, EMBED_MODEL_ID, newHash, notionPageId],
```
</interfaces>

<audit_ground_truth>
# Re-verified against the live tree 2026-04-23 — these line numbers are authoritative for the executor:

## File 1: services/dashboard-api/src/events.ts
- **Line 25** — `Source: 'kos.dashboard'` inside `publishCapture`. **THIS is the only line to change. Change to `'kos.capture'`.**
- Line 50 — `Source: 'kos.dashboard'` inside `publishOutput` (kos.output bus). **DO NOT TOUCH.** Different bus, different semantics, correct as-is.

## File 2: services/notion-indexer/test/entities-embedding.test.ts
- **Line 6** (jsdoc header comment) — `'cohere.embed-multilingual-v3'` → `'eu.cohere.embed-v4:0'`
- **Line 20** (vi.mock literal for EMBED_MODEL_ID) — `'cohere.embed-multilingual-v3'` → `'eu.cohere.embed-v4:0'`
- **Line 88** (test assertion `expect(vals[1]).toBe(...)`) — `'cohere.embed-multilingual-v3'` → `'eu.cohere.embed-v4:0'`
- No other occurrences in this file.

## File 3: services/bulk-import-kontakter/src/handler.ts
- **Lines 19–23** (header jsdoc paragraph about Embed-profile discovery) — describes `eu.*cohere.embed-multilingual-v3` profile + v3 fallback. Rewrite to describe the post-Wave-5 reality: resolver consumes `eu.cohere.embed-v4:0` via the EU inference profile, and v3 is unavailable in eu-north-1 Bedrock.
- **Lines 88–90** (cold-start log message inside `logBedrockEmbedProfile`) — mentions `eu.*cohere.embed-multilingual-v3 inference profile` + "falls back to base `cohere.embed-multilingual-v3` (cross-region us-east-1; GDPR note in SUMMARY)". Update to reference `eu.cohere.embed-v4:0` / `eu.*cohere.embed-v4` and drop the obsolete "cross-region us-east-1 fallback" language. This handler does **not** hardcode any model string in code paths — only jsdoc + log text. No runtime behavior changes.

## Nothing else found
- `grep -rn "cohere.embed-multilingual-v3"` against notion-indexer + bulk-import-kontakter + packages/resolver returns **zero** hits outside the lines above.
- `grep -rn "EMBED_MODEL_ID"` confirms notion-indexer/src/upsert.ts imports via `@kos/resolver` (no hardcode).
- `services/dashboard-api/tests/capture.test.ts` mocks `publishCapture` so does NOT assert against the EventBridge `Source` field — it only asserts the `detail.source` JSON field equals `'dashboard'` (line 64), which is unchanged by this fix. H1 edit does not break that test.
</audit_ground_truth>

<files_may_differ>
If any of the above line numbers are off-by-one from the live tree when the executor opens the file, adapt: the edits are content-based (exact string replace), not line-number-based. Always verify with `grep -n "cohere.embed-multilingual-v3"` before and after each edit to confirm 0 post-edit matches.
</files_may_differ>
</context>

<tasks>

<task type="auto">
  <name>Task 1: H1 — Route dashboard /capture through triage by fixing EventBridge Source</name>
  <files>services/dashboard-api/src/events.ts</files>
  <action>
  Open `services/dashboard-api/src/events.ts`. Inside the `publishCapture` function (around line 25), change the `Source` field from `'kos.dashboard'` to `'kos.capture'`.

  **Exact change (one line, inside publishCapture only):**
  ```diff
     Entries: [
       {
  -      Source: 'kos.dashboard',
  +      Source: 'kos.capture',
         DetailType: 'capture.received',
         Detail: JSON.stringify(detail),
         EventBusName: 'kos.capture',
       },
     ],
  ```

  **DO NOT touch `publishOutput`** (around line 50). Its `Source: 'kos.dashboard'` is correct for the `kos.output` bus (SSE fan-out to dashboard) and is semantically different from capture ingress. Post-edit the file will contain exactly **two** `Source:` lines — the earlier one (inside `publishCapture`) reads `'kos.capture',` and the later one (inside `publishOutput`) reads `'kos.dashboard',`.

  **Why this fix instead of broadening the EventBridge rule:** the triage rule in `packages/cdk/lib/stacks/integrations-agents.ts:205` filters `source: ['kos.capture']` intentionally — every capture should enter via the same canonical source regardless of channel (telegram, dashboard, email, iOS). Broadening the rule to accept `'kos.dashboard'` would fork that contract and create per-channel drift. One line in events.ts keeps the contract clean.

  **No test file changes required for H1.** The dashboard-api capture test (`services/dashboard-api/tests/capture.test.ts`) mocks the whole `../src/events.js` module, so it does not assert on the EventBridge `Source` string. It asserts on the `detail.source` JSON payload (`'dashboard'`) which is a separate field inside `Detail` and is unchanged here.
  </action>
  <verify>
    <automated>cd /home/ubuntu/projects/kevin-os/services/dashboard-api &amp;&amp; pnpm typecheck &amp;&amp; pnpm test &amp;&amp; test "$(grep -c \"Source: 'kos.capture'\" src/events.ts)" = "1" &amp;&amp; test "$(grep -c \"Source: 'kos.dashboard'\" src/events.ts)" = "1"</automated>
  </verify>
  <done>
  - `services/dashboard-api/src/events.ts` inside `publishCapture` reads `Source: 'kos.capture',`.
  - `services/dashboard-api/src/events.ts` inside `publishOutput` still reads `Source: 'kos.dashboard',` — unchanged.
  - `grep -n "Source:" src/events.ts` shows exactly two lines: the earlier (publishCapture) is `Source: 'kos.capture',`, the later (publishOutput) is `Source: 'kos.dashboard',`.
  - `pnpm typecheck` passes in `services/dashboard-api`.
  - `pnpm test` passes in `services/dashboard-api` (all capture.test.ts + merge-* tests green; the mocked `publishCapture` is agnostic to Source string).
  - Commit: `fix(dashboard-api): emit capture events with Source='kos.capture' (closes H1)`
  </done>
</task>

<task type="auto">
  <name>Task 2: H2 — Update notion-indexer entities-embedding test to assert v4 model ID</name>
  <files>services/notion-indexer/test/entities-embedding.test.ts</files>
  <action>
  Open `services/notion-indexer/test/entities-embedding.test.ts`. Replace all three occurrences of the stale v3 string with the current prod model ID.

  **Exact changes (three locations, same literal replace):**

  1. **Line 6** (jsdoc header comment):
  ```diff
  - *      writes {embedding, embedding_model='cohere.embed-multilingual-v3',
  + *      writes {embedding, embedding_model='eu.cohere.embed-v4:0',
  ```

  2. **Line 20** (`vi.mock` mock of `@kos/resolver` — the `EMBED_MODEL_ID` literal):
  ```diff
  - EMBED_MODEL_ID: 'cohere.embed-multilingual-v3',
  + EMBED_MODEL_ID: 'eu.cohere.embed-v4:0',
  ```

  3. **Line 88** (first test case's assertion on `vals[1]`):
  ```diff
  - expect(vals[1]).toBe('cohere.embed-multilingual-v3');
  + expect(vals[1]).toBe('eu.cohere.embed-v4:0');
  ```

  **Why the string literal rather than import the constant:** this is a `vi.mock` setup that replaces `@kos/resolver` wholesale. The mock factory runs before imports resolve, so using the real exported constant inside the mock factory would create a circular mock-of-the-thing-being-mocked situation. Keep the literal — just keep it in sync with the real constant. Add a short note to the jsdoc header (on a new line right before the final `*/` of the block comment at the top of the file):

  ```
   * NOTE: The EMBED_MODEL_ID literal in the vi.mock below MUST track
   * packages/resolver/src/embed.ts MODEL_ID (re-exported via
   * packages/resolver/src/index.ts as EMBED_MODEL_ID). Wave-5 Gap A
   * migrated off cohere.embed-multilingual-v3 → eu.cohere.embed-v4:0.
   * If you change the resolver constant, update this test in lockstep.
  ```

  After all edits, run `grep -n "cohere.embed-multilingual-v3" services/notion-indexer/test/entities-embedding.test.ts` — must return zero matches.
  </action>
  <verify>
    <automated>cd /home/ubuntu/projects/kevin-os/services/notion-indexer &amp;&amp; pnpm typecheck &amp;&amp; pnpm test &amp;&amp; test "$(grep -c 'eu.cohere.embed-v4:0' test/entities-embedding.test.ts)" -ge "3" &amp;&amp; ! grep -q "cohere.embed-multilingual-v3" test/entities-embedding.test.ts</automated>
  </verify>
  <done>
  - At least 3 occurrences of `eu.cohere.embed-v4:0` in `services/notion-indexer/test/entities-embedding.test.ts` (jsdoc line 6, mock line 20, assertion line 88; plus the new tracking note may add one more — all fine).
  - 0 occurrences of `cohere.embed-multilingual-v3` anywhere in that file.
  - `pnpm test` passes in `services/notion-indexer` (all 3 embedEntityIfNeeded tests green: first-sync, re-sync cache hit, bedrock-throws).
  - `pnpm typecheck` passes.
  - Commit: `test(notion-indexer): assert Cohere v4 EU model ID in entity embedding tests (closes H2 part 1)`
  </done>
</task>

<task type="auto">
  <name>Task 3: H2 — Remove stale Cohere v3 references from bulk-import-kontakter handler</name>
  <files>services/bulk-import-kontakter/src/handler.ts</files>
  <action>
  Open `services/bulk-import-kontakter/src/handler.ts`. There are two stale regions; neither affects runtime behavior (no hardcoded model ID in code paths — just jsdoc + one log message).

  **Region A — header jsdoc (lines 18–23):** replace the v3-centric paragraph with v4 accuracy.

  Current text to replace:
  ```
   * Embed-profile discovery (Open Question 2 runbook): on cold start, calls
   * `bedrock:ListInferenceProfiles` and logs whether an `eu.*cohere.embed-
   * multilingual-v3` profile exists. The profile ID is logged but NOT used
   * here — Task 2's indexer is the only consumer. If absent, indexer falls
   * back to base `cohere.embed-multilingual-v3` (cross-region us-east-1; GDPR
   * note in SUMMARY).
  ```

  New text:
  ```
   * Embed-profile discovery (Open Question 2 runbook): on cold start, logs
   * an operator breadcrumb pointing at `scripts/discover-bedrock-embed-profile.sh`.
   * The indexer (notion-indexer Task 2) is the only consumer of embeddings in
   * this pipeline and consumes the EU inference profile `eu.cohere.embed-v4:0`
   * via `packages/resolver/src/embed.ts` (exported as `EMBED_MODEL_ID` from
   * `@kos/resolver`). Wave-5 Gap A (2026-04-22) migrated off
   * `cohere.embed-multilingual-v3`, which is not available in eu-north-1
   * Bedrock. There is no fallback model — embeddings are only written to
   * entity_index once a row is Approved in the KOS Inbox.
  ```

  **Region B — cold-start log message (inside `logBedrockEmbedProfile`, lines ~85–91):** the current log text still references v3 and a nonexistent `COHERE_EMBED_MODEL_ID` env override.

  Current `console.log(...)` body to replace:
  ```typescript
  `[bulk-kontakter] Embed-profile discovery is operator-driven: run ` +
    `\`scripts/discover-bedrock-embed-profile.sh\` (region=${region}) to ` +
    `check for an eu.*cohere.embed-multilingual-v3 inference profile. ` +
    `Indexer (Task 2) honours COHERE_EMBED_MODEL_ID env override; if absent ` +
    `it uses the base model ID (cross-region us-east-1; GDPR-acceptable per A1).`,
  ```

  New body:
  ```typescript
  `[bulk-kontakter] Embed-profile discovery is operator-driven: run ` +
    `\`scripts/discover-bedrock-embed-profile.sh\` (region=${region}) to ` +
    `verify the eu.cohere.embed-v4:0 EU inference profile is reachable. ` +
    `Indexer (Task 2) consumes EMBED_MODEL_ID from @kos/resolver (currently ` +
    `eu.cohere.embed-v4:0); Wave-5 Gap A migrated off v3.`,
  ```

  **Preserve these existing pieces (do NOT touch):**
  - The jsdoc block above `logBedrockEmbedProfile` (lines ~72–80) explaining why `bedrock:ListInferenceProfiles` is delegated to a shell script to avoid pulling `@aws-sdk/client-bedrock` (control-plane SDK) into the Lambda bundle. Still accurate.
  - The `bedrockProfileLogged` idempotence flag.
  - Any import statements.
  - `KONTAKTER_DB_ID_OPTIONAL` env var logic.
  - All of `runImport`, `getPool`, `sleep`, `yyyymmdd`, and the exported `handler`.

  After edits, run:
  ```
  grep -nE "cohere\.embed-multilingual-v3|COHERE_EMBED_MODEL_ID|cross-region us-east-1" services/bulk-import-kontakter/src/handler.ts
  ```
  This must return **zero** matches.
  </action>
  <verify>
    <automated>cd /home/ubuntu/projects/kevin-os/services/bulk-import-kontakter &amp;&amp; pnpm typecheck &amp;&amp; pnpm test &amp;&amp; ! grep -qE "cohere\.embed-multilingual-v3|COHERE_EMBED_MODEL_ID|cross-region us-east-1" src/handler.ts &amp;&amp; grep -q "eu.cohere.embed-v4:0" src/handler.ts</automated>
  </verify>
  <done>
  - 0 occurrences of `cohere.embed-multilingual-v3`, `COHERE_EMBED_MODEL_ID`, or `cross-region us-east-1` in `services/bulk-import-kontakter/src/handler.ts`.
  - At least one occurrence of `eu.cohere.embed-v4:0` in the file (header jsdoc + log message both reference it).
  - `pnpm typecheck` passes in `services/bulk-import-kontakter`.
  - `pnpm test` passes (handler's runtime behavior is unchanged — no code-path edits).
  - Commit: `docs(bulk-import-kontakter): remove stale Cohere v3 fallback references (closes H2 part 2)`
  </done>
</task>

</tasks>

<verification>

## Full-scope verification (run all three commands from the repo root)

Run after all three tasks are committed:

```bash
# 1. All three affected workspaces typecheck and test green.
cd /home/ubuntu/projects/kevin-os

pnpm --filter @kos/dashboard-api typecheck
pnpm --filter @kos/dashboard-api test

pnpm --filter @kos/service-notion-indexer typecheck
pnpm --filter @kos/service-notion-indexer test

pnpm --filter @kos/service-bulk-import-kontakter typecheck
pnpm --filter @kos/service-bulk-import-kontakter test

# 2. Cross-repo confirmation of H1: dashboard-api publishes kos.capture; triage rule matches.
grep -n "Source:" services/dashboard-api/src/events.ts
# Expected output (exactly two lines):
#   line N:       Source: 'kos.capture',     ← publishCapture (previously 'kos.dashboard')
#   line M:       Source: 'kos.dashboard',   ← publishOutput  (UNCHANGED — kos.output bus)

grep -n "source: \['kos.capture'\]" packages/cdk/lib/stacks/integrations-agents.ts
# Expected: two matches (TriageFromCaptureRule line ~205, TriageFromVoiceTranscribedRule line ~221).

# 3. Cross-repo confirmation of H2: zero stale v3 references in affected scope.
grep -rn "cohere.embed-multilingual-v3" services/notion-indexer services/bulk-import-kontakter
# Expected output: (empty)

grep -rn "cohere.embed-multilingual-v3" packages/resolver
# Expected output: packages/resolver/src/embed.ts:3:// 2026-04-22 (Wave 5 Gap A): migrated from `cohere.embed-multilingual-v3`
# (One historical comment — intentional, documents the migration. Do NOT delete.)
```

## What this plan does NOT do (scope guard)

- **No AWS deploys.** `cdk deploy`, `cdk synth`, `aws lambda update-function-code`, anything that mutates live infra — NONE OF THAT. Local file edits + typecheck + vitest only.
- **No CDK changes.** `packages/cdk/lib/stacks/integrations-agents.ts` is not modified. The triage rule already accepts `'kos.capture'`; we change the publisher to match the rule, not the other way around.
- **No backfill, no re-emit, no outage reconciliation.** Audit gap M4 (notion-indexer 3-day drift) is separate work and not in this plan.
- **No Phase 2 or Phase 3 VERIFICATION.md issuance.** Audit gap M3 (gate discipline) is separate.
- **No documentation updates to `packages/resolver/src/embed.ts`.** Its line 3 comment intentionally documents the Wave-5 migration history — leave it.
- **No `publishOutput` change.** Different bus, different semantics, already correct.

</verification>

<success_criteria>

- [ ] `services/dashboard-api/src/events.ts` `publishCapture` emits `Source: 'kos.capture'`; `publishOutput` unchanged.
- [ ] `services/dashboard-api` typecheck + vitest green (all capture.test.ts + merge-* tests pass).
- [ ] `services/notion-indexer/test/entities-embedding.test.ts` asserts `'eu.cohere.embed-v4:0'` in all three locations (jsdoc line 6, mock line 20, assertion line 88); zero v3 string matches.
- [ ] `services/notion-indexer` typecheck + vitest green.
- [ ] `services/bulk-import-kontakter/src/handler.ts` has no `cohere.embed-multilingual-v3` / `COHERE_EMBED_MODEL_ID` / `cross-region us-east-1` text anywhere; references `eu.cohere.embed-v4:0` in both jsdoc header and cold-start log.
- [ ] `services/bulk-import-kontakter` typecheck + vitest green.
- [ ] Three atomic commits, one per task, matching the commit message suggestions in each task's `<done>`.
- [ ] `grep -rn "cohere.embed-multilingual-v3" services/notion-indexer services/bulk-import-kontakter` returns empty (the comment in `packages/resolver/src/embed.ts:3` is intentional and out of scope).

</success_criteria>

<output>
After completion, create `.planning/quick/260423-vra-fix-audit-h1-h2-route-dashboard-capture-/260423-vra-SUMMARY.md` documenting:

1. Exact diffs applied in each of the three files (or git commit SHAs).
2. The `grep` verification output showing zero stale v3 references and the correct Source emission.
3. Link back to audit gaps H1 + H2 as `audit_gaps_closed` in frontmatter.
4. Note that CDK/infra was NOT redeployed — next operator action is `cdk deploy` of the dashboard-api Lambda stack before the fix takes effect live (out of scope for this quick, but document as a followup).

The audit document `.planning/v1.0-MILESTONE-AUDIT.md` should be updated in a separate chore commit after this plan executes, flipping H1 and H2 gap entries to `resolved` with the commit SHAs as evidence. That re-audit step is not part of this plan — it belongs to the next `/gsd-audit-milestone` run.
</output>
