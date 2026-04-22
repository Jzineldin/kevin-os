---
phase: 02-minimum-viable-loop
plan: 04
subsystem: agents-triage-and-voice-capture
tags: [wave-2, agt-01, agt-02, triage, voice-capture, claude-agent-sdk, haiku-4-5, eventbridge, idempotency, langfuse, prompt-injection]
dependency_graph:
  requires:
    - "02-00 scaffolds (services/triage + services/voice-capture skeletons, services/_shared/tracing.ts, OTel deps wired)"
    - "02-01 CaptureStack (capture.received text + voice events on kos.capture)"
    - "02-02 transcribe-pipeline (capture.voice.transcribed events on kos.capture)"
    - "02-03 RDS at 1024-dim + kos_admin IAM user (live)"
    - "01-02 DataStack (RDS Proxy + 6 secret shells used by agents)"
    - "01-03 EventsStack (kos.capture/triage/agent/output buses)"
    - "01-04 KosLambda construct (nodejs22.x + arm64 + esbuild + 30-day logs)"
  provides:
    - "@kos/contracts TriageRoutedSchema (FINAL wide shape; carries source_text + sender + telegram for downstream agents)"
    - "@kos/contracts EntityMentionDetectedSchema (Plan 02-05 entity-resolver consumer)"
    - "services/triage production handler — AGT-01 Haiku 4.5 classifier on kos.capture → kos.triage"
    - "services/voice-capture production handler — AGT-02 Haiku 4.5 row-builder on kos.triage → Notion + kos.agent + kos.output"
    - "AgentsStack CDK + integrations-agents.ts wiring helper (extensible for Plan 02-05 entity-resolver)"
    - "2 EventBridge rules (TriageFromCaptureRule + VoiceCaptureFromTriageRule) with per-pipeline DLQs"
  affects:
    - "Plan 02-05 (entity-resolver, AGT-03): consumes entity.mention.detected from kos.agent (this plan is its sole producer)"
    - "Plan 02-06 (push-telegram): consumes output.push from kos.output emitted by voice-capture (is_reply=true)"
    - "Plan 02-09 (observability): both Lambdas emit Langfuse spans + Sentry errors"
tech_stack:
  added:
    - "@anthropic-ai/claude-agent-sdk Haiku 4.5 EU CRIS profile (eu.anthropic.claude-haiku-4-5) — first production wiring"
    - "@notionhq/client pages.create against Command Center DB"
  patterns:
    - "tsconfig rootDir lifted to services/ + paths mapping to per-service node_modules so ../../_shared/tracing.ts resolves transitive OTel deps without a workspace package indirection"
    - "Per-pipeline DLQs (kos-triage-dlq + kos-voice-capture-dlq) live in AgentsStack to avoid the EventsStack↔AgentsStack cyclic-reference problem (same pattern as Plan 02-02)"
    - "Wide triage.routed schema carries source_text + sender + telegram so voice-capture has everything it needs without re-fetching from S3 or DB (D-04 keeps Lambdas non-orchestrating; this is the price)"
    - "NOTION_COMMAND_CENTER_DB_ID injected at synth time from scripts/.notion-db-ids.json instead of bundling the JSON into the Lambda asset (mirrors Phase 1 notion-reconcile)"
    - "Module-scope cache for both pg pool (RDS Proxy IAM auth) and Notion client (Pitfall 11 cold-start mitigation)"
    - "JSON extraction defence-in-depth: agent.ts regex-pulls the first {...} block from the SDK's message stream, then zod-validates"
key_files:
  created:
    - services/triage/src/agent.ts
    - services/triage/src/persist.ts
    - services/voice-capture/src/agent.ts
    - services/voice-capture/src/persist.ts
    - services/voice-capture/src/notion.ts
    - packages/cdk/lib/stacks/agents-stack.ts
    - packages/cdk/lib/stacks/integrations-agents.ts
    - packages/cdk/test/agents-stack.test.ts
  modified:
    - packages/contracts/src/events.ts (TriageRoutedSchema + EntityMentionDetectedSchema appended)
    - services/triage/src/handler.ts (scaffold → production)
    - services/triage/test/handler.test.ts (scaffold → 3 behavioural tests)
    - services/triage/tsconfig.json (rootDir lift + paths mapping)
    - services/voice-capture/src/handler.ts (scaffold → production)
    - services/voice-capture/test/handler.test.ts (scaffold → 2 behavioural tests)
    - services/voice-capture/tsconfig.json (rootDir lift + paths mapping)
    - services/_shared/tracing.ts (typecast on ClaudeAgentSDKInstrumentation)
    - packages/cdk/bin/kos.ts (KosAgents wired)
decisions:
  - "TriageRoutedSchema authored as FINAL wide shape ONCE in Task 1 Step A — Task 2 does not redefine it. source_text + sender + telegram fields chosen over a re-fetch-from-S3 sidecar because the worst-case payload (~12KB) is well under the 256KB EventBridge per-event limit and the simplification eliminates a cross-Lambda S3 read."
  - "tsconfig rootDir lifted from . to .. + relative-include for ../_shared/**/*.ts. The `_shared/tracing.ts` is intentionally NOT a workspace package (per Plan 02-00 simpler-alternative decision); we inherit transitive type deps via per-service paths mapping. This keeps the agent-services portable but does not propagate to the bundle (esbuild externalises @aws-sdk/* and bundles the rest fine)."
  - "Per-pipeline DLQs in AgentsStack (kos-triage-dlq + kos-voice-capture-dlq) — same EventsStack↔ConsumerStack cycle that Plan 02-02 hit when reusing EventsStack DLQs. Per-pipeline DLQs also improve failure-isolation for Plan 02-09 alarming."
  - "NOTION_COMMAND_CENTER_DB_ID injected as env var at synth time rather than bundling notion-db-ids.json into the Lambda asset. This mirrors Phase 1 notion-reconcile and avoids fighting NodejsFunction's bundling defaults (it externalises @aws-sdk but bundles other JSON imports in unpredictable ways)."
  - "voice-capture/src/persist.ts is a copy of triage/src/persist.ts (intentional). Plan ADOPTED copy-over-extract while we're still in Wave 1; consolidation lands Phase 6+ when entity-resolver becomes the third consumer."
  - "rdsIamUser hardcoded as 'kos_admin' in bin/kos.ts to match Phase 1 notion-indexer convention. Future per-service IAM users can layer in via the AgentsStackProps."
metrics:
  duration_minutes: ~25
  completed: 2026-04-22
  tasks: 2
  files_created: 8
  files_modified: 9
  commits: 2
---

# Phase 2 Plan 04: Triage + Voice-Capture Agents Summary

AGT-01 + AGT-02 ship as paired Lambdas: every Telegram capture (text or transcribed voice) flows through the **triage agent** (Haiku 4.5; classifies route + detected_type + urgency) and is emitted as `triage.routed` on `kos.triage`. When `route='voice-capture'`, the **voice-capture agent** (also Haiku 4.5) writes a Notion Command Center row, emits one `entity.mention.detected` per detected entity to `kos.agent` (consumed by Plan 02-05), and fires one `output.push` to `kos.output` carrying `is_reply=true` so push-telegram (Plan 02-06) responds in-thread to Kevin's original message.

Both Lambdas use the FINAL wide `TriageRoutedSchema` carrying `source_text` + `sender` + `telegram` so voice-capture has everything it needs without re-fetching from S3/DB. D-21 idempotency is enforced via SELECT-before-run on `agent_runs`; D-25 Langfuse spans are flushed in a `finally` against a 2s timeout (Pitfall 9). T-02-TRIAGE-01 prompt injection is mitigated via `<user_content>...</user_content>` delimiters + a system-prompt rule that delimited content is DATA. Cost-cap (T-02-TRIAGE-02) is enforced via `maxTurns=1`, `allowedTools=[]`, `maxTokens=400` (triage) / 800 (voice-capture).

## Objective

Realize D-19 (separate Lambdas per agent), D-20 (Haiku 4.5 on EU CRIS profile via Claude Agent SDK), D-21 (capture_id idempotency), D-25 (Langfuse wiring) for AGT-01 + AGT-02. This plan is the consumer side of Plan 02-02's `capture.voice.transcribed` (no longer orphaned) and the producer of `entity.mention.detected` events that Plan 02-05's entity-resolver consumes.

## What Shipped

### Task 1 — Triage Lambda + event contracts (commit `a88bdec`)

- **`packages/contracts/src/events.ts`** — appended `TriageRoutedSchema` (FINAL wide shape: capture_id, source_kind, source_text ≤8000 chars, route, detected_type?, urgency?, reason ≤200, sender, telegram, routed_at) + `EntityMentionDetectedSchema` (capture_id, mention_text, context_snippet, candidate_type, source, occurred_at, notion_command_center_page_id?). Both pinned to the existing ULID regex.
- **`services/triage/src/agent.ts`** — Claude Agent SDK `query()` wrapper. systemPrompt is a 2-element array: `TRIAGE_BASE_PROMPT` + the Kevin Context block, both with `cache_control: { type: 'ephemeral' }`. User text wrapped in `<user_content>...</user_content>` delimiters. `model: 'eu.anthropic.claude-haiku-4-5'`, `maxTurns: 1`, `maxTokens: 400`, `allowedTools: []`. Defensive JSON extraction (`/\{[\s\S]*\}/`) before zod parse.
- **`services/triage/src/persist.ts`** — RDS Proxy IAM-auth pg pool (max=2; per-connection token signed via `@aws-sdk/rds-signer`); `findPriorOkRun` (D-21 dedup), `insertAgentRun`, `updateAgentRun`, `loadKevinContextBlock` (sorted by heading for cache-stability). Module-scope pool cache with `__resetPoolForTests`.
- **`services/triage/src/handler.ts`** — EventBridge target. Branches on `detail-type`: `capture.received` → text path; `capture.voice.transcribed` → voice path. Validates via the Plan 02-01 / 02-02 schemas, then runs the dedup → INSERT started → call agent → emit triage.routed → UPDATE ok cycle. Always `await langfuseFlush()` in `finally`.
- **`services/triage/test/handler.test.ts`** — 3 behavioural tests using mocked Bedrock + EventBridge + persist:
  - text capture → PutEvents triage.routed with `route='voice-capture'`, `source_kind='text'`, `source_text` round-trip, `sender.id` and `telegram.chat_id` round-trip
  - voice transcribed → PutEvents triage.routed with `source_kind='voice'`, transcript round-trip
  - prior ok run → no PutEvents (D-21 idempotency)

All 3 pass.

### Task 2 — Voice-capture Lambda + AgentsStack CDK (commit `a252c85`)

- **`services/voice-capture/src/agent.ts`** — Same SDK shape as triage but with `maxTokens: 800` and a richer output schema (`title`, `type`, `urgency`, `body`, `project_hint?`, `candidate_entities[]` ≤20). System prompt explicitly instructs Swedish-first output (Kevin code-switches SV/EN).
- **`services/voice-capture/src/notion.ts`** — `getNotion()` resolves the Notion client + Command Center DB ID once and caches in module scope. Token from Secrets Manager (`NOTION_TOKEN_SECRET_ARN`) with test fallback to `NOTION_TOKEN` env. DB ID via env var (`NOTION_COMMAND_CENTER_DB_ID`) with file fallback for tests. `writeCommandCenterRow()` calls `pages.create` with Name/Type/Urgency/Status/Capture ID properties + a single paragraph block carrying the body (truncated to 2000 chars).
- **`services/voice-capture/src/persist.ts`** — Copy of triage's (intentional per ADOPTED decision).
- **`services/voice-capture/src/handler.ts`** — EventBridge target on `kos.triage`. Parses TriageRoutedSchema, defensively re-checks `route === 'voice-capture'` (alongside the rule filter), runs the same idempotency cycle, then in sequence: (a) `runVoiceCaptureAgent`, (b) `writeCommandCenterRow` → `pageId`, (c) emit one `entity.mention.detected` per candidate (batched in groups of 10 for the EventBridge limit), (d) emit one `output.push` to `kos.output` with `is_reply: true` + `telegram.reply_to_message_id`. UPDATE ok with `notion_page_id` + entity count in `output_json`. langfuseFlush in finally.
- **`services/voice-capture/test/handler.test.ts`** — 2 behavioural tests:
  - happy path: writes Notion row, emits entity.mention.detected (with `notion_command_center_page_id` round-trip), emits output.push with `is_reply=true` + `body` containing "✅ Saved to Command Center" + `reply_to_message_id` round-trip
  - prior ok run → no PutEvents (D-21 idempotency)

Both pass.

- **`packages/cdk/lib/stacks/integrations-agents.ts`** — `wireTriageAndVoiceCapture(scope, props)`:
  - 2 KosLambdas (`TriageAgent` 30s/512MB, `VoiceCaptureAgent` 60s/1024MB)
  - 2 per-pipeline DLQs (`kos-triage-dlq` + `kos-voice-capture-dlq`) created IN this stack
  - 2 EventBridge rules:
    - `TriageFromCaptureRule` on `kos.capture` matching `detail-type ∈ ['capture.received', 'capture.voice.transcribed']` → triage Lambda
    - `VoiceCaptureFromTriageRule` on `kos.triage` matching `detail-type='triage.routed' AND detail.route=['voice-capture']` → voice-capture Lambda
  - IAM grants (least privilege per T-02 register): `bedrock:InvokeModel` scoped to Haiku 4.5 + Sonnet 4.6 foundation-model + EU CRIS inference-profile ARNs; `rds-db:connect` to the Proxy `dbuser:${DbiResourceId}/kos_admin`; secrets reads on Sentry/Langfuse/Notion; PutEvents on each Lambda's relevant bus subset (triage→kos.triage; voice-capture→kos.agent + kos.output).
- **`packages/cdk/lib/stacks/agents-stack.ts`** — Thin orchestration shell wrapping the helper. Plan 02-05 will extend the helper without editing this file.
- **`packages/cdk/bin/kos.ts`** — Instantiates `KosAgents` with addDependency on KosData (Proxy ARNs + secrets), KosEvents (4 buses), KosIntegrations (commandCenter ID source-of-truth file).
- **`packages/cdk/test/agents-stack.test.ts`** — 9 synth assertions covering: triage rule matches both detail-types + has DLQ, voice-capture rule filters route + has DLQ, agent Lambdas are nodejs22.x+arm64 (excludes CDK-managed LogRetention helper Lambda via `KEVIN_OWNER_ID` env presence), CLAUDE_CODE_USE_BEDROCK=1 + KEVIN_OWNER_ID + RDS env vars, bedrock:InvokeModel + rds-db:connect IAM (with `eu.anthropic.claude-haiku-4-5` substring proof), voice-capture-specific NOTION_COMMAND_CENTER_DB_ID + multi-bus PutEvents, timeout caps, dedicated DLQ names, and Lambda count.

All 9 pass; the full CDK suite is 73/73 green; `npx cdk synth KosAgents` succeeds (VoiceCaptureAgent bundle ~2.3MB unminified mjs source map, well under the 50MB Lambda zip limit).

## Verification

| Target | Status |
|--------|--------|
| `pnpm --filter @kos/contracts typecheck` | PASS |
| `pnpm --filter @kos/service-triage typecheck` | PASS |
| `pnpm --filter @kos/service-triage test -- --run` (3/3) | PASS |
| `pnpm --filter @kos/service-voice-capture typecheck` | PASS |
| `pnpm --filter @kos/service-voice-capture test -- --run` (2/2) | PASS |
| `pnpm --filter @kos/cdk typecheck` | PASS |
| `pnpm --filter @kos/cdk test -- --run agents-stack` (9/9) | PASS |
| `pnpm --filter @kos/cdk test -- --run` (73/73 across the whole suite) | PASS |
| `KEVIN_TELEGRAM_USER_ID=111222333 KEVIN_OWNER_ID=… cdk synth KosAgents --quiet` | PASS |
| `grep -q TriageRoutedSchema packages/contracts/src/events.ts` | PASS (2 hits) |
| `grep -q "source_text: z.string().max(8000)" packages/contracts/src/events.ts` | PASS |
| `grep -q "sender: z.object" packages/contracts/src/events.ts` | PASS (4 hits) |
| `grep -q "telegram: z.object" packages/contracts/src/events.ts` | PASS (4 hits) |
| `grep -q EntityMentionDetectedSchema packages/contracts/src/events.ts` | PASS |
| `grep -q "eu.anthropic.claude-haiku-4-5" services/triage/src/agent.ts` | PASS |
| `grep -q "<user_content>" services/triage/src/agent.ts` | PASS (3 hits) |
| `grep -q "cache_control: { type: 'ephemeral'" services/triage/src/agent.ts` | PASS (2 hits) |
| `grep -q findPriorOkRun services/triage/src/handler.ts` | PASS |
| `grep -q langfuseFlush services/triage/src/handler.ts` | PASS |
| `grep -q "EventBusName: 'kos.triage'" services/triage/src/handler.ts` | PASS |
| `grep -q "maxTurns: 1" services/triage/src/agent.ts` | PASS |
| `grep -q "eu.anthropic.claude-haiku-4-5" services/voice-capture/src/agent.ts` | PASS |
| `grep -q "<user_content>" services/voice-capture/src/agent.ts` | PASS |
| `grep -q writeCommandCenterRow services/voice-capture/src/handler.ts` | PASS |
| `grep -q "is_reply: true" services/voice-capture/src/handler.ts` | PASS |
| `grep -q "EventBusName: 'kos.agent'" services/voice-capture/src/handler.ts` | PASS |
| `grep -q "entity.mention.detected" services/voice-capture/src/handler.ts` | PASS |
| `grep -q wireTriageAndVoiceCapture packages/cdk/lib/stacks/agents-stack.ts` | PASS |
| `grep -q "route: \['voice-capture'\]" packages/cdk/lib/stacks/integrations-agents.ts` | PASS |
| `grep -q "bedrock:InvokeModel" packages/cdk/lib/stacks/integrations-agents.ts` | PASS |
| `grep -q "new AgentsStack" packages/cdk/bin/kos.ts` | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] tsconfig rootDir + module resolution for `../../_shared/tracing.ts`**

- **Found during:** Task 1 first `pnpm --filter @kos/service-triage typecheck`
- **Issue:** Plan 02-00 placed `_shared/tracing.ts` outside any service's tsconfig rootDir; the relative `../../_shared/tracing.ts` import that the plan dictates would error with `TS6059: File '_shared/tracing.ts' is not under 'rootDir'` AND `TS2307: Cannot find module '@opentelemetry/sdk-trace-node'` (because tsc resolves modules from the source-file location upward, and `services/_shared/` has no node_modules).
- **Fix:** Lifted `rootDir` from `.` to `..` and added `../_shared/**/*.ts` to `include`. Added a `paths` mapping for `@opentelemetry/*`, `@langfuse/*`, `@arizeai/*` pointing at the per-service node_modules so tsc can find the type packages without us promoting `_shared` into a workspace package.
- **Files modified:** `services/triage/tsconfig.json`, `services/voice-capture/tsconfig.json`
- **Commits:** `a88bdec` (triage), `a252c85` (voice-capture)
- **Rule rationale:** Rule 3 — blocked typecheck and therefore the whole task.

**2. [Rule 1 — Bug] `_shared/tracing.ts` ClaudeAgentSDKInstrumentation type drift**

- **Found during:** Task 1 typecheck after fixing rootDir.
- **Issue:** `@arizeai/openinference-instrumentation-claude-agent-sdk@0.2.x` exposes an `Instrumentation<ClaudeAgentSDKModule>` shape with a `setConfig(config: ClaudeAgentSDKModule)` signature that doesn't unify with `@opentelemetry/instrumentation`'s `Instrumentation<InstrumentationConfig>` (`setConfig(config: InstrumentationConfig)`). Telegram-bot doesn't import `_shared/tracing.ts` and therefore Plan 02-00 never surfaced this; triage is the first downstream consumer.
- **Fix:** Single-line `as unknown as never` cast on the `new ClaudeAgentSDKInstrumentation()` argument inside `registerInstrumentations`. Runtime contract is unchanged; only the surface mismatch is suppressed.
- **Files modified:** `services/_shared/tracing.ts`
- **Commit:** `a88bdec`
- **Rule rationale:** Rule 1 — typecheck-blocking type bug introduced by Plan 02-00 that only manifests when a downstream service compiles `_shared`.

**3. [Rule 2 — Correctness] Filter CDK helper Lambdas out of `agents-stack.test.ts` Lambda assertions**

- **Found during:** Task 2 first `pnpm --filter @kos/cdk test -- --run agents-stack`.
- **Issue:** CDK's `logRetention` config on `KosLambda` synthesises a `LogRetention` helper Lambda per Lambda (deprecated path; `logRetention` warning showed up). The agents-stack test naively asserted on `findResources('AWS::Lambda::Function')` and saw 3 functions instead of 2, breaking the runtime/arch and timeout assertions when iterating.
- **Fix:** Introduced an `agentFns()` helper that filters by `Environment.Variables.KEVIN_OWNER_ID` presence — the agent Lambdas have it, the LogRetention helper doesn't. All Lambda-iterating assertions now use `agentFns()`.
- **Files modified:** `packages/cdk/test/agents-stack.test.ts` (only the test file; production code is correct)
- **Commit:** `a252c85`
- **Rule rationale:** Rule 2 — without the filter the test would report a false-positive failure even though the production stack is correct.

## Notion DB ID Bundling Choice

The Plan suggested `additionalAssetFiles: [{ src: …, dest: 'notion-db-ids.json' }]` to bundle `scripts/.notion-db-ids.json` into the Lambda. KosLambda doesn't support that prop, and NodejsFunction's bundling defaults externalise `@aws-sdk/*` but interact unpredictably with sibling JSON imports. Adopted the simpler, established pattern from Phase 1 `notion-reconcile`: read `scripts/.notion-db-ids.json` at synth time and inject the relevant ID (`commandCenter`) as an env var (`NOTION_COMMAND_CENTER_DB_ID`). The Lambda code uses the env var directly (`notion.ts` will fall back to a `notion-db-ids.json` file lookup for tests via `NOTION_DB_IDS_PATH` if needed). Net: same source-of-truth, fewer moving parts at deploy time.

## Authentication Gates

None encountered. All work is local (TypeScript + CDK synth); no AWS deploy performed as part of this plan. Live verification (Telegram → Notion round-trip) is deferred to the operator runbook below.

## Operator Runbook — Post-Deploy

After `cdk deploy KosAgents`:

1. Confirm `KEVIN_OWNER_ID` is set in the deploy environment (env var or `--context kevinOwnerId=…`).
2. Seed Phase 2 secrets if not already done (Plan 02-00 / 02-03):
   - `kos/sentry-dsn`
   - `kos/langfuse-public-key` + `kos/langfuse-secret-key`
   - `kos/notion-token`
3. Send a Telegram text to the Kevin bot: `Ping Damien om convertible loan`. Expected within ~5s:
   - `triage.routed` on `kos.triage` with `route='voice-capture'`
   - 1 new row in Notion Command Center with title + Type=Task + Urgency=MED
   - 1 `entity.mention.detected` on `kos.agent` for "Damien"
   - 1 `output.push` on `kos.output` with `is_reply=true` carrying "✅ Saved to Command Center · …"
4. Send a Swedish voice memo. After Transcribe (10-30s), the same chain fires off the `capture.voice.transcribed` event.
5. CloudWatch checks:
   - `/aws/lambda/KosAgents-TriageAgent*`: should show `{routed: 'voice-capture'}`
   - `/aws/lambda/KosAgents-VoiceCaptureAgent*`: should show `{notion_page_id: 'xxx', entities: 1}`
6. Langfuse cloud should show 1 trace per agent invocation with `agent_name`, `capture_id`, `model_id` attributes.

If Plan 02-06 push-telegram is not yet deployed, the `output.push` event will sit on the bus (no consumer) and be dropped after the bus's default retention — Kevin will see the Notion row arrive but no Telegram ack. Plan 02-06 closes that loop.

## Threat-Register Coverage

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-TRIAGE-01 (Tampering — prompt injection) | mitigated | Both `agent.ts` modules wrap user text in `<user_content>...</user_content>` (verified: 3 hits each); system prompt instructs the model that delimited content is DATA. Extracting JSON via regex before zod parse provides a second layer (model can't subvert the schema). |
| T-02-TRIAGE-02 (Denial of Wallet — runaway cost) | mitigated | `maxTurns: 1` + `maxTokens: 400` (triage) / 800 (voice-capture) + `allowedTools: []` enforced in `agent.ts`. Bedrock IAM scoped to Haiku 4.5 + Sonnet 4.6 ARNs only. |
| T-02-TRIAGE-03 (Tampering — duplicate Notion row from EB retry storm) | mitigated | `findPriorOkRun(captureId, agentName, ownerId)` is the first DB call after event-shape validation; UPDATE ok happens after the PutEvents/Notion side-effects. Idempotency unit test covers both Lambdas. |
| T-02-TRIAGE-04 (Info Disclosure — Kevin Context PII in Langfuse) | accepted | Per plan; deferred to Plan 02-09 (Langfuse redaction config). |
| T-02-TRIAGE-05 (Spoofing — fake EB event) | mitigated | EB rule patterns lock down `source` (`kos.capture` / `kos.triage`); CDK IAM puts PutEvents only on roles owned by the bot/triage Lambdas. |
| T-02-TRIAGE-06 (DoS — Bedrock throttle → Lambda timeout) | mitigated | Triage timeout 30s, voice-capture 60s; SDK default exponential retry; EB rule retryAttempts: 2 + maxEventAge: 1h; per-pipeline DLQ catches sustained failures. |

## Known Stubs

None. Both Lambdas are end-to-end functional; the `output.push` event is consumed by Plan 02-06 push-telegram (next plan) — not a stub but a normal event-driven decoupling per D-04.

## Threat Flags

None. Plan 02-04 introduces no NEW security surface beyond the threat-register entries above. The new Lambdas are inside the AWS account boundary, talk only to Bedrock (least-privilege IAM), RDS Proxy (IAM auth), Notion API (Secrets Manager token), Langfuse cloud (egress-only), and EventBridge (rule-filtered).

## Handoffs to Next Plan

- **Plan 02-05 (entity-resolver, AGT-03 / ENT-09):** consumes `entity.mention.detected` from `kos.agent`. The detail shape is the `EntityMentionDetectedSchema` zod-validated form. The plan's wiring helper (`integrations-agents.ts`) is structured so 02-05 can extend it with a third Lambda + a third rule on `kos.agent` without touching this plan's code paths.
- **Plan 02-06 (push-telegram, OUT-01):** consumes `output.push` from `kos.output`. The detail shape is `{capture_id, is_reply, body, telegram: {chat_id, reply_to_message_id}}`. push-telegram MUST honour `is_reply: true` to maintain in-thread Telegram conversation flow per D-02 stage-2 ack.
- **Plan 02-09 (observability):** add CloudWatch alarms on `kos-triage-dlq` and `kos-voice-capture-dlq` `ApproximateNumberOfMessagesVisible > 0`; Langfuse PII-redaction config; Sentry release-name pinning per agent.

## Commits

| Hash | Message |
|------|---------|
| `a88bdec` | feat(02-04): triage Lambda (AGT-01) + TriageRouted/EntityMentionDetected schemas |
| `a252c85` | feat(02-04): voice-capture Lambda (AGT-02) + AgentsStack CDK |

## Self-Check: PASSED

Verified files on disk:
- services/triage/src/agent.ts — FOUND
- services/triage/src/persist.ts — FOUND
- services/triage/src/handler.ts — MODIFIED (production)
- services/triage/test/handler.test.ts — MODIFIED (3 passing tests)
- services/triage/tsconfig.json — MODIFIED
- services/voice-capture/src/agent.ts — FOUND
- services/voice-capture/src/persist.ts — FOUND
- services/voice-capture/src/notion.ts — FOUND
- services/voice-capture/src/handler.ts — MODIFIED (production)
- services/voice-capture/test/handler.test.ts — MODIFIED (2 passing tests)
- services/voice-capture/tsconfig.json — MODIFIED
- services/_shared/tracing.ts — MODIFIED (typecast)
- packages/contracts/src/events.ts — MODIFIED (TriageRoutedSchema + EntityMentionDetectedSchema)
- packages/cdk/lib/stacks/agents-stack.ts — FOUND
- packages/cdk/lib/stacks/integrations-agents.ts — FOUND
- packages/cdk/test/agents-stack.test.ts — FOUND (9 passing tests)
- packages/cdk/bin/kos.ts — MODIFIED (KosAgents wired)

Verified commits in `git log --all`:
- `a88bdec feat(02-04): triage Lambda (AGT-01) + TriageRouted/EntityMentionDetected schemas` — FOUND
- `a252c85 feat(02-04): voice-capture Lambda (AGT-02) + AgentsStack CDK` — FOUND
