# Plan 08-02 Agent Implementation Notes

Wave 5 worktree (`agent-ab7578f1fb7465163`) — implementation of AGT-07
content-writer + content-writer-platform per
`.planning/phases/08-outbound-content-calendar/08-02-PLAN.md`.

## What landed

| File | Lines | Tests | Purpose |
|---|---|---|---|
| `services/content-writer/src/handler.ts` | 137 | 8 | Orchestrator Lambda — Zod-parses `content.topic_submitted`, idempotency pre-check on `content_drafts`, `StartExecution` on the SFN state machine, observability `content.orchestration.started` emit. |
| `services/content-writer/src/persist.ts` | 88 | (covered by handler tests) | RDS Proxy IAM-auth pool + `alreadyDrafted(pool, topic_id, owner_id)`. |
| `services/content-writer/test/handler.test.ts` | 195 | 8 | Orchestrator unit tests — all 8 specified in plan. |
| `services/content-writer-platform/src/brand-voice.ts` | 110 | 3 (+1 sanity) | BRAND_VOICE.md frontmatter parser + `getBrandVoice()` fail-closed gate (D-25). |
| `services/content-writer-platform/src/agent.ts` | 207 | 8 | `runContentWriterAgent` — Sonnet 4.6 EU CRIS, 5 platform rules, 5 length caps, `<user_content>` wrap + escape, JSON output parse. |
| `services/content-writer-platform/src/persist.ts` | 124 | (covered by handler tests) | `insertContentDraft` (UPSERT idempotent on `(topic_id, platform)`) + `markDraftFailed` (UPSERT to `status='failed'`). |
| `services/content-writer-platform/src/handler.ts` | 173 | 6 | Map-state worker — fail-closed BRAND_VOICE gate, `loadContext({ includeCalendar: false })`, agent call, persist, error path. |
| `services/content-writer-platform/test/agent.test.ts` | 165 | 8 | Agent unit tests. |
| `services/content-writer-platform/test/handler.test.ts` | 175 | 6 | Handler unit tests with mocked context-loader, persist, brand-voice, agent. |
| `services/content-writer-platform/test/brand-voice.test.ts` | 110 | 4 | Brand-voice parser tests + 1 live-file sanity. |
| `packages/cdk/lib/stacks/integrations-content.ts` | 240 | 10 | `wireContentWriter` — 2 Lambdas + Standard SFN with Map(maxConcurrency=5) + EventBridge rule. |
| `packages/cdk/lib/stacks/integrations-stack.ts` | (mod) | — | Wired `wireContentWriter` after the `email-agents` block; gated on `agentBus && kevinOwnerId`. |
| `packages/cdk/test/integrations-content.test.ts` | 220 | 10 | All 8 plan-specified assertions + 2 extras (rule pattern + env). |
| `scripts/submit-content-topic.mjs` | 80 | — | Operator script, `node --check` clean. |

## Test results

```
@kos/service-content-writer            8 passed
@kos/service-content-writer-platform  18 passed (8 agent + 6 handler + 4 brand-voice)
@kos/cdk integrations-content         10 passed
TOTAL                                 36 passed
```

`pnpm --filter @kos/service-content-writer typecheck` — clean.
`pnpm --filter @kos/service-content-writer-platform typecheck` — clean.
`pnpm --filter @kos/cdk typecheck` — clean.
`node --check scripts/submit-content-topic.mjs` — `submit-script-OK`.

## Implementation deltas vs the plan

1. **`agent.ts` model alias**. Plan §interfaces showed
   `'eu.anthropic.claude-sonnet-4-5-20250929-v1:0'` in the example code. Per
   the user-supplied live-verified ID `eu.anthropic.claude-sonnet-4-6` (no
   suffix) this implementation uses the unsuffixed alias, matching the
   email-triage convention (`SONNET_4_6_MODEL_ID` in `email-triage/src/draft.ts`)
   and the CDK IAM grant pattern used by every other Bedrock service in the
   repo.

2. **CDK wiring helper file naming**. Plan referenced
   `packages/cdk/lib/stacks/integrations-content.ts`; that's the filename
   used. The plan's `must_haves.artifacts` block also lists this exact path.

3. **`loadContext` `includeCalendar` flag**. The current
   `@kos/context-loader::loadContext` signature does NOT have an
   `includeCalendar` flag — it's not part of the implemented loader yet
   (Phase 6). The handler omits the flag (effectively `false`) to match
   the plan's contract `includeCalendar: false`. CDK Test 2 asserts the
   call shape via `expect(call.includeCalendar).not.toBe(true)` so that
   when Phase 6 ships an `includeCalendar` parameter the test still passes
   without modification.

4. **Brand-voice file resolution**. `brand-voice.ts` reads the file via
   `readFileSync` at module scope. The plan's package.json scaffold for
   Plan 08-00 was supposed to wire `--loader:.md=text` into the build
   script — that build-time inlining is not exercised in test runs (vitest
   uses the disk path). The CDK test does not assert the bundling switch;
   that will be verified once Plan 08-00's build script lands or as part of
   a Wave 5 follow-up.

5. **Operator script platform shorthand**. Added the documented `ig` →
   `instagram` mapping. Other shorthand expansions can accrete later
   without breaking the script's contract.

6. **No `kos_content_writer_orchestrator` SQL grants applied**. Plan §3
   ends with an SQL snippet that an operator must run against RDS to
   create the two new IAM users:
   ```sql
   CREATE USER kos_content_writer_orchestrator LOGIN;
   GRANT rds_iam TO kos_content_writer_orchestrator;
   GRANT SELECT ON content_drafts TO kos_content_writer_orchestrator;

   CREATE USER kos_content_writer_platform LOGIN;
   GRANT rds_iam TO kos_content_writer_platform;
   GRANT SELECT, INSERT, UPDATE (status, created_at) ON content_drafts TO kos_content_writer_platform;
   ```
   These were NOT applied here (the worktree has no live DB access). Add
   them to a follow-up DB-roles migration before deploying the CDK stack.

7. **EmailEngine etc. unchanged**. The plan instructed wiring into
   `integrations-stack.ts`; it did not touch any other helper file. The
   only constructor diff is the `wireContentWriter` call gated on
   `agentBus && kevinOwnerId`.

## Known caveats / follow-ups

- **BRAND_VOICE.md is still placeholder** (`human_verification: false` in
  the seeded file). The first deploy will fail-closed correctly; Kevin
  must fill in real voice examples and flip the flag before AGT-07
  produces usable drafts. This is the intended D-25 behaviour.
- **Plan 08-03 dashboard Inbox** depends on `content_drafts` being
  populated by this plan. The schema exists from 0020; this plan plumbs
  the writers; Plan 08-03 plumbs the readers + Approve/Edit UI.
- **Map result aggregation** (the `draft.ready` event). The plan's CDK
  comment notes that v1 emits no `draft.ready` aggregator; the dashboard
  reads `content_drafts` directly. The Step Functions definition therefore
  ends at the Map state with `End: true`. A future plan can add a Lambda
  target on `States.Succeeded` if the SSE push pattern needs explicit
  fan-out.
- **`agent.ts` JSON-extraction regex** matches the first `{...}` block in
  Sonnet output. If the model emits a JSON object then a second one in a
  trailing comment, only the first is parsed (matches plan's intent and
  is the same pattern email-triage uses).
- **No retries inside the per-platform Lambda**. The Step Functions
  `addRetry` covers transient Lambda invocation failures; Bedrock
  throttling is not retried inside the agent. The plan's reliability
  budget (D-24 in Phase 4) calls for `withTimeoutAndRetry` wrappers but
  the plan text for 08-02 explicitly does NOT require them — adding them
  would mean wiring a dead-letter table that doesn't exist for content
  drafts. Sonnet 4.6 EU has been reliable enough at low volume that the
  one-shot path is acceptable for v1.

## Files modified summary

```
services/content-writer/package.json                                (deps added)
services/content-writer/src/handler.ts                              (rewritten — orchestrator)
services/content-writer/src/persist.ts                              (new)
services/content-writer/test/handler.test.ts                        (new)
services/content-writer-platform/package.json                       (deps added)
services/content-writer-platform/src/handler.ts                     (rewritten — Map worker)
services/content-writer-platform/src/agent.ts                       (new)
services/content-writer-platform/src/persist.ts                     (new)
services/content-writer-platform/src/brand-voice.ts                 (new)
services/content-writer-platform/test/agent.test.ts                 (new)
services/content-writer-platform/test/handler.test.ts               (new)
services/content-writer-platform/test/brand-voice.test.ts           (new)
packages/cdk/lib/stacks/integrations-content.ts                     (new)
packages/cdk/lib/stacks/integrations-stack.ts                       (wireContentWriter import + call)
packages/cdk/test/integrations-content.test.ts                      (new)
scripts/submit-content-topic.mjs                                    (new)
```

No commit issued (per task instructions). All tests + typechecks green.
