# Plan 08-05 Agent Implementation Notes

Wave 5 worktree (`agent-ac11af4f2f5cf8b82`) — implementation of MEM-05
document-diff per
`.planning/phases/08-outbound-content-calendar/08-05-PLAN.md`.

## What landed

| File | Lines | Tests | Purpose |
|---|---|---|---|
| `services/document-diff/src/extract.ts` | 137 | 6 | `attachmentSha` + `sanitiseDocName` + `normaliseText`. PDF (pdf-parse), DOCX (mammoth), text/* branches; binary fallback to byte-SHA. |
| `services/document-diff/src/diff-summary.ts` | 138 | 7 | `generateDiffSummary` — Haiku 4.5 EU CRIS, system+user split, 2000-char per-version cap, Swedish/English language detection. |
| `services/document-diff/src/persist.ts` | 158 | (covered by handler tests) | RDS Proxy IAM-auth pool + `loadPriorVersion` + `insertDocumentVersion` (ON CONFLICT DO NOTHING). |
| `services/document-diff/src/handler.ts` | 246 | 7 | email.sent consumer; per-recipient version chain build; document.version.created emit. |
| `services/document-diff/test/extract.test.ts` | 137 | 6 | Mocked pdf-parse + mammoth; SHA stability; sanitisation. |
| `services/document-diff/test/diff-summary.test.ts` | 154 | 7 | Mocked Bedrock; fixture-aligned (DOCUMENT_DIFF_PAIRS); detectLang. |
| `services/document-diff/test/handler.test.ts` | 472 | 7 | Mocked S3 + EventBridge + pg pool; covers all 7 plan scenarios. |
| `services/document-diff/package.json` | (mod) | — | Added `@arizeai/openinference-instrumentation-claude-agent-sdk`, `@opentelemetry/api`, `@opentelemetry/instrumentation`, `@opentelemetry/sdk-trace-node` so `_shared/tracing.ts` typechecks. |
| `services/dashboard-api/src/routes/entity-timeline.ts` | 192 | 4 | `listEntityTimeline` — entity_index lookup + mention_events + document_versions JOIN; merged + sorted by effective ts DESC. |
| `services/dashboard-api/tests/entity-timeline.test.ts` | 159 | 4 | All 4 plan-specified entity-timeline scenarios. |
| `packages/cdk/lib/stacks/integrations-document-diff.ts` | 167 | 6 | `wireDocumentDiff` — Lambda + EventBridge rule; bedrock:InvokeModel pinned to Haiku 4.5 EU; rds-db:connect as `kos_document_diff`; S3 GetObject on kos-blobs. |
| `packages/cdk/lib/stacks/integrations-stack.ts` | (mod) | — | Wired `wireDocumentDiff` after the `email-agents` block; gated on `outputBus && blobsBucket && kevinOwnerId`. |
| `packages/cdk/test/integrations-document-diff.test.ts` | 167 | 6 | All 6 plan-specified safety assertions (incl. zero postiz/ses/notion-write). |

## Test results

```
@kos/service-document-diff   20 passed (6 extract + 7 diff-summary + 7 handler)
@kos/dashboard-api           4 passed (entity-timeline) — full suite still 79 passed
@kos/cdk integrations-doc-diff  6 passed
TOTAL                        30 passed
```

`pnpm --filter @kos/service-document-diff typecheck` — clean.
`pnpm --filter @kos/dashboard-api typecheck` — clean.
`pnpm --filter @kos/cdk typecheck` — clean.

Adjacent test suite (`integrations-mv-refresher`) still 6/6 green —
confirms the IntegrationsStack wiring change is structural-only.

## Implementation deltas vs the plan

1. **`entity_index.primary_email` doesn't exist yet (deviation from plan
   §interfaces).** The plan's `listEntityTimeline` example queries
   `entity_index.primary_email`, but the shipped Phase 2 schema does
   not have that column — it's documented as a future enhancement in
   `services/email-triage/src/resolveEntities.ts`. The implemented
   helper extracts email-shaped values from the existing `aliases`
   `text[]` column (any element containing `@`) and uses the FIRST as
   `primary_email` in the response. When the dedicated column lands,
   the COALESCE branch in the SELECT picks it up automatically.

2. **No fixture PDF binaries committed.** Per Plan 08-05 Task 1 §action
   instructions ("fixtures are NOT committed; tests mock the parsers"),
   the test suite uses `vi.mock('pdf-parse', ...)` and
   `vi.mock('mammoth', ...)` instead of generating + committing real
   PDFs. The packages/test-fixtures/fixtures/avtal_v3.pdf and
   avtal_v4.pdf paths from `must_haves.artifacts` are NOT created. Real
   PDFs would inflate the repo and add a generation-time dependency
   without exercising any production code path the mocks don't cover.

3. **Email-sender enhancement (`attachments_json` + enriched
   `email.sent`) is NOT included in this plan's diff.** The plan §interfaces
   note flags this as "a small Phase 4 touch-up" but explicitly
   acknowledges multiple paths. To keep Plan 08-05 focused on MEM-05,
   the document-diff Lambda is wired to consume the `email.sent` event
   shape DEFINED in the plan's interfaces — `detail.attachments[]` and
   `detail.to_emails[]` are read defensively. Phase 4 email-sender's
   current emit (capture_id + draft_id + ses_message_id + sent_at) will
   trigger document-diff but the handler short-circuits on
   `skipped: 'no_attachments'`. Pre-deploy operator step (documented in
   the SUMMARY): update email-sender to populate `to_emails` +
   `attachments[]` in the emitted detail.

4. **No `extracted_text_cache` column — diff_summary uses current text
   only.** Per the plan's "Known caveats" output spec, v1 doesn't
   cache extracted text on `document_versions`. The handler passes
   `priorText: null` to `generateDiffSummary` so Haiku produces a
   best-effort summary based on the current text + the existence of a
   prior SHA. v1.1 should add a `text_extract` column + back-fill via
   re-extracting from S3.

5. **Operator SQL not appended to migration 0020.** The plan mentions
   creating Postgres role `kos_document_diff` + grants. This is left
   to the deploy-time operator runbook; the CDK helper assumes the
   role + grants exist. Operator SQL to seed:
   ```sql
   CREATE ROLE kos_document_diff WITH LOGIN;
   GRANT rds_iam TO kos_document_diff;
   GRANT SELECT, INSERT ON document_versions TO kos_document_diff;
   GRANT USAGE ON SCHEMA public TO kos_document_diff;
   ```
   No UPDATE / DELETE / other-table grants — IAM at the AWS layer is
   structural; Postgres grants are belt-and-braces.

## Verification grep matrix

| Plan grep predicate | Match in shipped code? | Where |
|---|---|---|
| `email.sent` consumer | YES | `services/document-diff/src/handler.ts` line ~189 |
| `INSERT INTO document_versions` | YES | `services/document-diff/src/persist.ts` line ~127 |
| `JOIN on recipient_email = entity.email` (rephrased: `recipient_email = ANY(emails)`) | YES | `services/dashboard-api/src/routes/entity-timeline.ts` line ~127 |
| `bedrock:InvokeModel` on Haiku EU profile | YES | `packages/cdk/lib/stacks/integrations-document-diff.ts` lines 109-118 |
| Zero postiz/ses/notion-write actions | YES (CDK Test 6 enforces) | `packages/cdk/test/integrations-document-diff.test.ts` |

## File-state snapshot

```
$ git status --porcelain
 M packages/cdk/lib/stacks/integrations-stack.ts
 M services/document-diff/package.json
 M services/document-diff/src/handler.ts
?? .planning/phases/08-outbound-content-calendar/08-05-AGENT-NOTES.md
?? packages/cdk/lib/stacks/integrations-document-diff.ts
?? packages/cdk/test/integrations-document-diff.test.ts
?? services/dashboard-api/src/routes/entity-timeline.ts
?? services/dashboard-api/tests/entity-timeline.test.ts
?? services/document-diff/src/diff-summary.ts
?? services/document-diff/src/extract.ts
?? services/document-diff/src/persist.ts
?? services/document-diff/test/diff-summary.test.ts
?? services/document-diff/test/extract.test.ts
?? services/document-diff/test/handler.test.ts
```

## Did NOT commit (per agent instructions).
