# Phase 7: Lifecycle Automation — Context

**Gathered:** 2026-04-24
**Status:** Ready for planning
**Branch:** phase-02-wave-5-gaps (writing directly to main tree, no worktree)

<domain>
## Phase Boundary

The "daily and weekly rhythm" phase. KOS runs the morning/day-close/weekly-review briefs that Kevin used to do by hand — short, prose-first, calm-by-default. Every scheduled Lambda respects the Phase 1 notification cap (3/day) and quiet-hours (20:00–08:00 Stockholm). Slipped items surface in the NEXT brief so nothing disappears. Every brief is a single Sonnet 4.6 Bedrock invocation using `@kos/context-loader::loadContext()` (Phase 6) for full entity awareness, producing structured output via Bedrock `tool_use` so rendering to Notion + Telegram is deterministic.

**In scope:**
- **AUTO-01 (07:00 Stockholm weekdays)** — `services/morning-brief` Lambda on EventBridge Scheduler cron `0 7 ? * MON-FRI *` Europe/Stockholm. loadContext({ entityIds: hot entities from last-48h mention_events, agentName: 'morning-brief', captureId: <ulid> }) → Sonnet 4.6 tool_use `morning_brief` → write 🏠 Today Notion page (replace-in-place) + append row to Daily Brief Log Notion DB + emit ONE `output.push` to kos.output (counts as 1-of-3 cap).
- **AUTO-02 schedule only (every 2h 08:00–18:00 weekdays)** — EventBridge Scheduler cron `0 8/2 ? * MON-FRI *` Europe/Stockholm targeting the EXISTING `kos.system / scan_emails_now` event that Phase-4 `services/email-triage` Lambda already consumes. **Zero Lambda code in Phase 7 for this.** Just a scheduler.
- **AUTO-03 (18:00 Stockholm weekdays)** — `services/day-close` Lambda on cron `0 18 ? * MON-FRI *`. loadContext + Sonnet 4.6 tool_use `day_close_brief` → append Daily Brief Log entry + update Kevin Context page (Recent decisions / Slipped items / Active threads sections) + emit ONE `output.push` (1-of-3 cap).
- **AUTO-04 (Sunday 19:00)** — `services/weekly-review` Lambda on cron `0 19 ? * SUN *`. loadContext over full week → Sonnet 4.6 tool_use `weekly_review` → append Daily Brief Log + overwrite Kevin Context "Active threads" section + emit ONE `output.push`.
- Shared renderer `services/_shared/brief-renderer.ts` — takes a BriefSchema object + produces (a) Notion blocks array for 🏠 Today replace-in-place, (b) Notion blocks for Daily Brief Log append, (c) Telegram HTML parse_mode message string (<4096 chars Telegram limit).
- Shared Zod `@kos/contracts/src/brief.ts` — `MorningBriefSchema`, `DayCloseBriefSchema`, `WeeklyReviewSchema`. Each defines the `tool_use` schema Sonnet returns.
- Dropped-threads surfacing — SQL view `dropped_threads_v` in migration 0014 that composes with Phase 6's `entity_timeline_mv` + a new `top3_membership` table. The morning-brief Lambda queries this view; dropped items (Top 3 from last brief not actioned + last_mentioned > 24h ago) get rendered in the "dropped threads" brief section.
- 14-day invariant verifier `scripts/verify-notification-cap-14day.mjs` — reads `agent_runs` + `telegram_inbox_queue` + `denied_messages` (existing D-12 telemetry) over 14 days, asserts no day has >3 pushes; runs as CloudWatch EventBridge Scheduler alarm weekly (Sunday 03:00 Stockholm) against the cap table.
- Quiet-hours invariant verifier `scripts/verify-quiet-hours-invariant.mjs` — asserts zero push-telegram invocations where `localHour(Stockholm) ∈ [20, 8)`.

**Out of scope:**
- Email triage agent implementation (Phase 4 already shipped AGT-05). Phase 7 adds ONLY the Scheduler.
- Morning brief consumption of AUTO-05 Granola transcripts (Phase 6 already publishes mention_events; morning-brief reads the same tables).
- Dashboard 🏠 Today rendering (Phase 3 — the dashboard already reads Notion 🏠 Today page; Phase 7 just writes to it).
- Content generation via AGT-07 / AGT-08 (Phase 8).
- Any Phase 8/9/10 scheduled job.
- Live cloud mutations (no `cdk deploy`, no Notion page creation via operator). Operator runbooks document first-run steps.

</domain>

<decisions>
## Implementation Decisions

Authoritative locks for Phase 7. Source artefacts:
- `<artifacts_to_produce>` orchestrator brief's "recommended defaults — Kevin asleep, pick the recommended"
- ROADMAP §Phase 7 + REQUIREMENTS (AUTO-01..04)
- Phase 6 CONTEXT (loadContext shape)
- Phase 4 Plan 04-04 (email-triage Lambda — AUTO-02 schedule wires here)
- Phase 1 SafetyStack (cap table, push-telegram quiet-hours/cap enforcement via `enforceAndIncrement`)
- `services/push-telegram/src/cap.ts` + `quiet-hours.ts` — the existing §13 contract

All seven gray areas resolved with the recommended defaults (Kevin asleep — defaults locked). No deviations.

### Brief generation model

- **D-01 [LOCKED — recommended default]**: **Sonnet 4.6 throughout** for all three briefs (morning, day-close, weekly-review). No Haiku-draft + Sonnet-polish split. Rationale: brief quality > cost; Sonnet 4.6 input ~$3/M tokens; typical brief input 8–12k tokens + Kevin Context cache (~3k) + context-loader dossier block (~6k) + output 1–2k ≈ $0.03/brief. Volume: 5 morning + 5 day-close + 1 weekly = 11/week = 44/mo = **~$1.32/mo Bedrock for briefs** (well under the $3–5/mo budget envelope). EU inference profile `eu.anthropic.claude-sonnet-4-6-20251022-v1:0` (same as Phase 2 entity-resolver + Phase 4 email-triage draft).

### Brief storage substrate

- **D-02 [LOCKED — recommended default]**: **BOTH** — write to Notion 🏠 Today page (replace-in-place — archive existing children blocks, append fresh blocks) AND append a row to the existing `Daily Brief Log` Notion DB (one row per brief; `type` property = `morning` | `day-close` | `weekly-review`; `date` property = Stockholm calendar date). Rationale: 🏠 Today is the at-a-glance glanceable artifact Kevin already reads; Daily Brief Log becomes the week/month query substrate and feeds Azure Search indexer (Phase 6 Plan 06-03 already has `services/azure-search-indexer-daily-brief` as a placeholder — starts producing documents once Phase 7 ships).
- **D-03 [LOCKED]**: **Notion IDs for both artifacts come from `scripts/.notion-db-ids.json`** via the `loadNotionIds()` pattern established in `integrations-notion.ts`. New required keys: `todayPage` (🏠 Today page id) and `dailyBriefLog` (Daily Brief Log DB id). Operator pre-seeds these IDs in the JSON file before `cdk deploy`; runtime throws an actionable error if either key is missing (same pattern as existing `kevinContext`, `entities`).

### Schedule cron timezone

- **D-04 [LOCKED — recommended default]**: **Native `Europe/Stockholm`** on every `CfnSchedule`. `scheduleExpressionTimezone: 'Europe/Stockholm'`. NO UTC-with-manual-DST-math. EventBridge Scheduler handles DST automatically (CET→CEST last Sunday of March, CEST→CET last Sunday of October). Same pattern as Phase 1 `integrations-notion.ts` schedules. `flexibleTimeWindow: { mode: 'OFF' }` on every schedule — briefs must fire at the exact wall-clock minute.

### Tool_use schema shape

- **D-05 [LOCKED — recommended default]**: **Shared schema in `@kos/contracts/src/brief.ts`**. Zod-validated. Three Zod schemas with common base fields + brief-type-specific extensions:
  ```
  BriefCommonFields:
    prose_summary: string (max 600 chars; 3-5 sentences — prose-first, calm)
    top_three: { title: string; entity_ids: string[]; urgency: 'high'|'med'|'low' }[1..3]
    dropped_threads: { title: string; entity_ids: string[]; last_mentioned_at: ISO }[0..5]

  MorningBriefSchema extends BriefCommonFields with:
    calendar_today: { start: ISO; end?: ISO; title: string; attendees?: string[] }[]
    calendar_tomorrow: { start: ISO; end?: ISO; title: string; attendees?: string[] }[]
    drafts_ready: { draft_id: UUID; from: string; subject: string; classification: 'urgent'|'important' }[0..10]

  DayCloseBriefSchema extends BriefCommonFields with:
    slipped_items: { title: string; entity_ids: string[]; reason?: string }[0..5]
    recent_decisions: string[0..5]        // each <= 200 chars
    active_threads_delta: { thread: string; status: 'new'|'updated'|'closed' }[0..10]

  WeeklyReviewSchema (no Top 3 / no dropped_threads — weekly cadence):
    prose_summary: string (max 1000 chars)
    week_recap: string[0..10]              // bullet highlights, each <= 240 chars
    next_week_candidates: { title: string; why: string }[0..7]
    active_threads_snapshot: { thread: string; where: 'almi'|'speed'|'tale-forge'|'outbehaving'|'other'; status: string }[]
  ```
  Each Lambda defines its own Bedrock `tool_use` tool definition consistent with the schema. Sonnet is forced via `tool_choice: { type: 'tool', name: '...' }`. Zod validation on the tool_use input; on parse failure, fallback to a safe minimal brief (prose_summary=`"Brief generation failed — see CloudWatch log"`; empty arrays) + emit `kos.system / brief.generation_failed` for operator visibility.

### Dropped-threads detection

- **D-06 [LOCKED — recommended default]**: **SQL view `dropped_threads_v`** in migration 0014 composes with Phase 6's `entity_timeline_mv` + a new `top3_membership` table (tracks each time an entity landed in a brief's Top 3). Morning-brief Lambda queries:
  ```
  SELECT * FROM dropped_threads_v
  WHERE owner_id = $1 AND detected_for_date = $2::date
  ORDER BY last_mentioned_at DESC LIMIT 5;
  ```
  View definition (0014 migration):
  ```
  CREATE OR REPLACE VIEW dropped_threads_v AS
  SELECT
    tm.owner_id,
    tm.brief_date AS membered_on,
    (CURRENT_DATE AT TIME ZONE 'Europe/Stockholm')::date AS detected_for_date,
    tm.entity_id,
    ei.name AS entity_name,
    tm.top3_title AS title,
    MAX(me.occurred_at) AS last_mentioned_at,
    MAX(tm.acted_on_at) AS last_acted_on_at
  FROM top3_membership tm
  JOIN entity_index ei ON ei.id = tm.entity_id
  LEFT JOIN mention_events me ON me.entity_id = tm.entity_id AND me.owner_id = tm.owner_id
  WHERE tm.acted_on_at IS NULL
    AND tm.brief_date >= (CURRENT_DATE AT TIME ZONE 'Europe/Stockholm' - INTERVAL '7 days')::date
  GROUP BY tm.owner_id, tm.brief_date, tm.entity_id, ei.name, tm.top3_title
  HAVING MAX(me.occurred_at) IS NULL OR MAX(me.occurred_at) < (NOW() - INTERVAL '24 hours');
  ```
  `top3_membership` table written to by each brief Lambda AFTER Sonnet returns the structured output (for each `top_three[i].entity_ids[j]` pair, INSERT a row). `acted_on_at` flipped to NOW() by a trigger on `mention_events` INSERT (Phase 6 already has a similar trigger pattern for dossier cache — copy the shape). Rationale: SQL view cleanly composes with existing MV; no ad-hoc Lambda query logic; idempotent recomputation per morning brief.

### Cap-invariant 14-day verifier

- **D-07 [LOCKED — recommended default]**: **CloudWatch EventBridge Scheduler weekly alarm** — a new Lambda `services/verify-notification-cap` invoked via `CfnSchedule` every Sunday 03:00 Stockholm (before the weekly review at 19:00, so failures show up in that brief). The Lambda runs `scripts/verify-notification-cap-14day.mjs` logic inline (reads DynamoDB cap table + `telegram_inbox_queue` + `denied_messages`). On violation, emits `kos.system / brief.compliance_violation` (SNS → email via SafetyStack alarmTopic). Zero-touch compliance — Kevin gets an email if the cap ever drifted. Same script works standalone for developer runs.

### Telegram message aggregation

- **D-08 [LOCKED — recommended default]**: **Single Telegram message per brief, Telegram HTML parse_mode**. Each brief produces ONE `output.push` event to `kos.output` with `body` = HTML-formatted brief (≤4096 chars per Telegram Bot API limit; if longer, truncate prose_summary + bullet sections by priority — Top 3 and dropped threads are must-keep). `is_reply` unset/false (scheduled push, NOT Kevin-initiated). Push-telegram Lambda's `enforceAndIncrement` applies the cap + quiet-hours check; if capped, the brief text is auto-queued to `telegram_inbox_queue` for the next allowed window. Rationale: one push = one cap slot; HTML parse_mode gives bold/italic/links for calm readability; no emoji fatigue.

### Additional operational locks

- **D-09 [LOCKED]**: Each brief Lambda writes an `agent_runs` row keyed by `capture_id := ulid()` (brief run id), `agent_name := 'morning-brief' | 'day-close' | 'weekly-review'`, with `output_json` containing the Zod-validated brief schema object. This both participates in the existing idempotency pattern (same cap_id → skip) AND feeds Phase 3 dashboard `/api/inbox` if Kevin wants a brief-history view later.
- **D-10 [LOCKED]**: `tagTraceWithCaptureId` + `initSentry` wired on every Phase 7 Lambda per `services/_shared/sentry.ts + tracing.ts` pattern. Langfuse trace tagged with `agent_name=morning-brief|day-close|weekly-review`. Matches the Phase 2 Plan 02-10 observability pattern.
- **D-11 [LOCKED]**: Each brief Lambda is VPC-attached to `PRIVATE_WITH_EGRESS` subnets with `rdsSecurityGroup` per the Phase 2 wave-5 fix (Lambdas needing RDS Proxy + Secrets Manager must be in VPC). Memory: morning-brief 1024 MB / 10 min timeout; day-close 1024 MB / 10 min; weekly-review 1536 MB / 10 min (larger context for full-week rollup); verify-notification-cap 512 MB / 3 min.
- **D-12 [LOCKED]**: IAM — every brief Lambda has `bedrock:InvokeModel` on `eu.anthropic.claude-sonnet-4-6-*` inference profile + foundation-model ARNs. `rds-db:connect` on kos_admin (reusing existing role — briefs write top3_membership + agent_runs; simpler than minting a new RDS user). `secretsmanager:GetSecretValue` on Notion token + Azure Search admin (if context-loader needs Azure at runtime — it does per Phase 6). `events:PutEvents` on `kos.output` (for the Telegram push) AND on `kos.system` (for failure events). **Explicitly NO ses:*** (structural — briefs don't send email).
- **D-13 [LOCKED]**: Lambda env: `KEVIN_OWNER_ID=9e4be978-cc7d-571b-98ec-a1e92373682c` (same as Phase 4 convention); `NOTION_TOKEN_SECRET_ARN`, `NOTION_TODAY_PAGE_ID`, `NOTION_DAILY_BRIEF_LOG_DB_ID`, `NOTION_KEVIN_CONTEXT_PAGE_ID`; `AZURE_SEARCH_ADMIN_SECRET_ARN`; `OUTPUT_BUS_NAME=kos.output`; `SYSTEM_BUS_NAME=kos.system`; `RDS_PROXY_ENDPOINT`; `RDS_IAM_USER=kos_admin`; `RDS_DATABASE=kos`.
- **D-14 [LOCKED]**: Migration number = **0014**. Rationale: 0001–0011 are applied in the filesystem; Phase 6 reserves 0012 (per 06-CONTEXT D-24 reference to "migration 0010" + 06 Plan 06-00 note "migration 0012"); Phase 4 reserves 0012 with bump-to-0013 on Phase-6-first-land. To avoid a 3-way collision, Phase 7 uses `0014_phase_7_top3_membership_and_dropped_threads_v.sql`. At execution time, if Phase 6 actually lands at 0012 AND Phase 4 lands at 0013, then 0014 is correct. If either reshuffles, Phase 7 executor bumps to `0015_...` (next-available check in 07-00 Task 3, mirrors the 04-00 pattern).
- **D-15 [LOCKED]**: CDK helper `integrations-lifecycle.ts` in `packages/cdk/lib/stacks/`. Exports `wireLifecycleAutomation(scope, props)` — creates the 4 brief Lambdas + the `kos-schedules` group schedules (5 schedules: morning, day-close, weekly, email-scan, cap-verify). Mirror the Phase 1 `integrations-notion.ts` split-by-helper pattern. `IntegrationsStack` gets a fifth helper call.
- **D-16 [LOCKED]**: AUTO-02 scheduler = **one schedule group entry** named `email-triage-every-2h` with cron `0 8/2 ? * MON-FRI *` Europe/Stockholm (fires at 08:00, 10:00, 12:00, 14:00, 16:00, 18:00 Stockholm — 6 fires/weekday). Target = Phase-4 `kos.system / scan_emails_now` (via `CfnSchedule.target.arn` pointing at an EventBridge bus + PutEvents role — NOT direct Lambda invoke, to keep Phase 4's dispatch semantics intact). This means Phase 7 creates a scheduler role with `events:PutEvents` permission on `kos.system` and a JSON `target.input` = `{"detail-type":"scan_emails_now","source":"kos.system","detail":{"requested_at":"<@at>"}}` — **actually**, EventBridge Scheduler targets Lambda or SQS/SNS/EventBus directly; to post to an EventBridge bus we use target.arn = bus ARN + RoleArn with `events:PutEvents`. Verified pattern via AWS EventBridge Scheduler docs.
- **D-17 [LOCKED]**: Morning-brief hot-entity selection — `entityIds` for `loadContext({ entityIds })` = top 10 entities by `count(mention_events WHERE occurred_at > now() - interval '48 hours' AND entity_id IS NOT NULL)` GROUP BY entity_id ORDER BY count DESC LIMIT 10. Day-close uses same query scope but interval 12 hours. Weekly uses interval 7 days with LIMIT 20. Rationale: briefs get full dossier awareness for the entities Kevin actually interacted with, not every entity in the graph.
- **D-18 [LOCKED]**: Quiet-hours check for morning-brief: fires at 07:00 Stockholm — before the 20:00–08:00 quiet window closes at 08:00. `enforceAndIncrement` in push-telegram will run at 07:00 with `isQuietHour(new Date())` returning true (07:00 < 08:00). **This is the designed exception:** morning-brief sends at 07:00 Stockholm which falls INSIDE the quiet-hours window as defined by `quiet-hours.ts` (`h >= 20 || h < 8` → 07 qualifies). Per the orchestrator brief "The morning brief is a cap-allowed push that bypasses the 20:00-08:00 block by virtue of firing at 07:00 — just before the window closes." This is a **policy contradiction** — `quiet-hours.ts` says 08:00 is the end (07:00 is quiet). Two options:
  - **Option A [LOCKED]**: Tighten the morning-brief schedule to **`0 8 ? * MON-FRI *`** (08:00 Stockholm — just outside the quiet window; `isQuietHour(08:00)` = false). This matches AUTO-01 spec "07:00 Stockholm" loosely — shipping at 08:00 is still early morning and honors the quiet-hours invariant cleanly. No code bypass needed.
  - Option B (rejected): introduce an `is_brief_bypass` flag in `OutputPushSchema`. Rejected because it creates a new bypass surface in the cap enforcer.
  **Decision: Option A**. AUTO-01 schedule = `0 8 ? * MON-FRI *` Stockholm. Document the 07:00 → 08:00 drift in the plan + SUMMARY. If Kevin wants 07:00 literal, future enhancement can adjust quiet-hours end time to 07:00 (coordinated change; out of Phase 7 scope).
- **D-19 [LOCKED]**: Cost envelope for Phase 7 monthly ≤ **$5/mo** net-new:
  - Sonnet 4.6: 44 brief invocations × ~$0.03 avg = **$1.32/mo**
  - Lambda invocations: ~50/week × 52 = 2600/yr = negligible (<$0.20/mo)
  - EventBridge schedulers: 5 schedules, ~1000 fires/mo = <$0.01/mo
  - Additional verify-cap Lambda: 4/mo = negligible
  - RDS (top3_membership writes): negligible (RDS already provisioned)
  - **Total estimate: ~$1.50/mo** (well under budget).

### Claude's Discretion

- Exact Sonnet 4.6 system prompts for each brief (hand-tuned during execution; tool_use schemas are locked by D-05).
- Notion block tree layout for 🏠 Today page (heading levels, emoji use — will mirror Kevin's existing manual layout; inspectable via Notion API during execution).
- Telegram HTML formatting details (bold vs italic vs pre) — discretion within the ≤4096 char constraint.
- Internal helper layout of `services/_shared/brief-renderer.ts` (single file vs submodules).
- Exact memory/timeout tuning within D-11 bounds.
- Whether `verify-notification-cap-14day.mjs` logic is inline in the Lambda or shared via a tiny `scripts/lib/cap-verifier.mjs` library.
- Dropped-threads `HAVING` threshold (24h hard-coded in D-06 view; may tighten to 48h if empirical false-positive rate too high).

### Folded Todos

None — STATE.md Active Todos are Phase 1 / Phase 4 / Phase 3 concerns. No Phase-7-shaped pending todo.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project definition & scope
- `.planning/PROJECT.md` — KOS vision; **Locked Decision #3 REVISED 2026-04-23** (direct AnthropicBedrock SDK; briefs use this exact pattern).
- `.planning/REQUIREMENTS.md` — Phase 7 owns AUTO-01, AUTO-02 (schedule), AUTO-03, AUTO-04.
- `.planning/ROADMAP.md` §Phase 7 — goal, 5 success criteria, depends on Phase 6+4+3.
- `.planning/STATE.md` — 14 locked decisions, #11 especially (3 Telegram/day cap at infra layer, NOT Phase-7 concern).

### Phase 1 carry-forward
- `.planning/phases/01-infrastructure-foundation/01-03-SUMMARY.md` — `kos-schedules` Scheduler group exists; Phase 7 adds entries.
- `.planning/phases/01-infrastructure-foundation/01-07-SUMMARY.md` — SafetyStack: DynamoDB `TelegramCap` table + push-telegram Lambda + `enforceAndIncrement` + quiet-hours (20:00–08:00 Stockholm).
- `packages/cdk/lib/stacks/safety-stack.ts` — push-telegram + cap table + SNS alarm topic; Phase 7 adds a cloudwatch-alarm-via-lambda path subscribing to the same alarmTopic.
- `packages/cdk/lib/stacks/integrations-notion.ts` — **PATTERN** for Phase 7's `integrations-lifecycle.ts`: `CfnSchedule` + scheduler role + `grantInvoke`/`grantPutEventsTo` + `loadNotionIds()` extension.
- `services/push-telegram/src/cap.ts + quiet-hours.ts` — the enforcement Phase 7 MUST NOT bypass.

### Phase 2 carry-forward
- `services/triage/src/{handler,agent,persist}.ts` — direct AnthropicBedrock pattern; Phase 7 mirrors exactly.
- `services/entity-resolver/src/disambig.ts` — tool_use Bedrock pattern with Zod validation (Phase 7 uses the same shape for brief tools).
- `packages/contracts/src/events.ts` — `OutputPushSchema` is what briefs emit to `kos.output`; `is_reply` stays unset/false.

### Phase 4 carry-forward (AUTO-02 target)
- `.planning/phases/04-email-pipeline-ios-capture/04-04-PLAN.md` — email-triage Lambda, consumes `kos.system / scan_emails_now`.
- `.planning/phases/04-email-pipeline-ios-capture/04-05-PLAN.md` — `scripts/fire-scan-emails-now.mjs` operator trigger; Phase 7 creates the scheduled equivalent.
- **Key point**: Phase 4 already built the full email-triage agent + the EventBridge rule on `kos.system / scan_emails_now`. Phase 7 contributes ZERO Lambda code for AUTO-02 — only an EventBridge Scheduler.

### Phase 6 carry-forward (loadContext dependency)
- `.planning/phases/06-granola-semantic-memory/06-CONTEXT.md` — D-12..D-16 on `@kos/context-loader::loadContext()` signature.
- `.planning/phases/06-granola-semantic-memory/06-05-PLAN.md` — library shape; briefs call `loadContext({ entityIds: <D-17 hot entities>, agentName: 'morning-brief'|'day-close'|'weekly-review', captureId: <brief ulid>, ownerId })`.
- `packages/context-loader/src/index.ts` (created by Phase 6) — exports `loadContext` + `loadKevinContextBlock`.

### External specs
- AWS EventBridge Scheduler cron syntax — `https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html#cron-based` (6-field cron: `min hour day-of-month month day-of-week year`; `?` wildcard required on one of day-of-month / day-of-week).
- EventBridge Scheduler Europe/Stockholm timezone + DST — `https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-timezones.html`.
- Notion block API — `https://developers.notion.com/reference/patch-block-children` (append children) and `https://developers.notion.com/reference/delete-a-block` (archive children; Notion has no bulk-replace, so "replace-in-place" = list children → archive each → append new children; rate-limited 3 RPS per integration).
- Notion database-row append — `https://developers.notion.com/reference/post-page` (create page in DB).
- Bedrock `tool_use` with `tool_choice` — `https://docs.anthropic.com/en/api/messages` (proven in Phase 2 entity-resolver).
- AnthropicBedrock SDK `@anthropic-ai/bedrock-sdk` — `https://github.com/anthropics/anthropic-sdk-typescript/tree/main/packages/bedrock-sdk` (EU inference profile IDs).
- Telegram Bot API sendMessage parse_mode HTML — `https://core.telegram.org/bots/api#sendmessage` (4096 char limit; HTML tags: `<b>`, `<i>`, `<code>`, `<a href="...">`, `<pre>`).

### Project conventions
- `CLAUDE.md` §"Recommended Stack" — Sonnet 4.6 via Bedrock EU profile; EventBridge Scheduler (not cron rules); notifications via Telegram mobile push.
- `CLAUDE.md` §"Lifecycle Automation" — AUTO-01..05 spec.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `packages/cdk/lib/constructs/kos-lambda.ts` — KosLambda Node 22 ARM64 + 30-day logs + externalised `@aws-sdk/*`. Every Phase 7 Lambda uses this construct unchanged.
- `packages/cdk/lib/stacks/events-stack.ts` — `kos-schedules` Scheduler group exists; Phase 7 adds 5 `CfnSchedule` entries.
- `packages/cdk/lib/stacks/safety-stack.ts` — `TelegramCap` DynamoDB + push-telegram Lambda. Phase 7 verify-cap Lambda reads the same table. SafetyStack's `alarmTopic` is where `brief.compliance_violation` SNS goes (D-07).
- `packages/cdk/lib/stacks/integrations-notion.ts` — **exact pattern to mirror** for `integrations-lifecycle.ts`: load Notion IDs, KosLambda creation, scheduler role + `grantInvoke`, `CfnSchedule` per cron.
- `packages/contracts/src/events.ts` — `OutputPushSchema` reused; Phase 7 adds `MorningBriefSchema` / `DayCloseBriefSchema` / `WeeklyReviewSchema` in new `packages/contracts/src/brief.ts`.
- `services/triage/src/agent.ts` — Sonnet 4.6 tool_use reference; Phase 7 brief Lambdas copy shape.
- `services/entity-resolver/src/disambig.ts` — Zod safeParse on tool_use input with safe fallback (locked pattern from Phase 2).
- `services/_shared/sentry.ts + tracing.ts` — every Phase 7 Lambda imports both (D-10).
- `services/push-telegram/src/handler.ts` — already subscribes to `kos.output / output.push`; Phase 7 briefs emit this event — zero new wiring on the consumer side.
- `packages/context-loader/src/index.ts` (Phase 6) — `loadContext` library; Phase 7 imports as runtime dep.
- `services/notion-indexer/src/*` — Notion client + page-children patterns; Phase 7 brief-renderer mirrors.

### Established Patterns

- **Single-responsibility Lambdas** — one brief per service folder; no consolidation.
- **Schedule expression timezone** = `Europe/Stockholm` always; `flexibleTimeWindow: OFF`; `state: 'ENABLED'` (D-04).
- **Direct AnthropicBedrock SDK** — per PROJECT.md Locked #3 revision 2026-04-23. No Agent SDK. Each Lambda is a dedicated Bedrock caller.
- **Bedrock tool_use + Zod** — force structured output via `tool_choice: { type: 'tool', name }` + validate tool input with Zod (Phase 2 entity-resolver + Phase 4 email-triage both use this).
- **Idempotency via agent_runs** — each brief run = one `agent_runs` row keyed by brief ulid; replay-safe.
- **RDS Proxy IAM auth** — `rds-db:connect` on `kos_admin`; pool bootstrap mirrors `services/triage/src/persist.ts`.
- **Secrets Manager VPC endpoint** — available from Phase 2 wave-5 config; Lambdas in PRIVATE_WITH_EGRESS subnets with rdsSecurityGroup get Secrets Manager access via VPC endpoint.
- **Notion replace-in-place** — for 🏠 Today page: list children → archive each → append new blocks. Rate-limited 3 RPS (Notion API); morning-brief's block churn (~30 blocks) means ~10 seconds sequential or ~3 seconds with 3-concurrent writes. Budget 15s for Notion write.

### Integration Points

- `kos.output` bus — brief Lambdas emit `output.push` (consumed by existing push-telegram Lambda; cap + quiet-hours enforced there).
- `kos.system` bus — Phase 7 scheduler emits `scan_emails_now` (consumed by Phase-4 email-triage; **zero new target wiring needed**, Phase 4 rule already exists).
- `kos.system` bus — verify-cap Lambda emits `brief.compliance_violation` (Phase 7 adds a new SNS rule: `kos.system / brief.compliance_violation` → SafetyStack.alarmTopic).
- Notion 🏠 Today page — new `todayPage` key in `scripts/.notion-db-ids.json`; Phase 7 operator runbook documents seeding.
- Notion Daily Brief Log DB — existing in Kevin's workspace (per PROJECT.md §"Existing Stack"); Phase 7 adds `dailyBriefLog` key.
- `top3_membership` table — new in migration 0014; written by brief Lambdas; read by `dropped_threads_v`.

</code_context>

<specifics>
## Specific Ideas

- **Wave ordering**: Wave 0 = scaffold (package skeletons + contracts + migration + CDK stub). Wave 1 = `services/morning-brief` alone (most complex single brief; bears the Top 3 + dropped-threads logic). Wave 1 parallel = `services/day-close` + `services/weekly-review` (same shape; different prompts + schemas). Wave 2 = AUTO-02 scheduler CDK addition (tiny; can ship independently). Wave 3 = verifier scripts + CloudWatch compliance alarm + E2E gate. Note: morning-brief depends on dropped_threads_v which depends on Wave 0 migration — hence morning-brief in Wave 1, not Wave 0.
- **Shared brief-renderer**: `services/_shared/brief-renderer.ts` produces three outputs per brief: `{ notionTodayBlocks: Block[], notionDailyBriefLogPage: PageCreateRequest, telegramHtml: string }`. Called identically by all three Lambdas. Renderer is pure-function (input schema → output artifacts); testable in isolation.
- **Notion replace-in-place transaction**: list children → archive each (PATCH `/blocks/{id}` with `archived: true`) → append new children (PATCH `/blocks/{page_id}/children`). NOT atomic in Notion (no transaction support); Phase 7 accepts this — if the Lambda crashes mid-replace, 🏠 Today gets a partially-replaced page; next morning's run cleans up (archive-all-existing before append). Worst case: Kevin sees stale content for up to 24h. Acceptable for a single-user system.
- **Top 3 derivation**: Sonnet 4.6 picks the Top 3 from the `top_three` tool_use field. The Lambda provides hints in the user prompt: (a) unanswered drafts (status='draft' email_drafts), (b) Command Center rows with `Prioritet` = 'Hög' AND status NOT 'Klar', (c) entities with highest recent mention counts. Sonnet synthesises. No hardcoded Top 3 algorithm.
- **Dropped-threads invariant**: the `top3_membership` table stores (brief_date, entity_id, top3_title, acted_on_at). `acted_on_at` is NULL at insert; the Phase 6 `mention_events` INSERT trigger updates `acted_on_at = NOW()` for any matching (owner_id, entity_id) pair. This is a weak signal (mentioning an entity = acting on it), but good enough for the calm-by-default heuristic. Stronger signals (email sent, Notion task Status → Klar) are deferred to a future refinement.
- **Weekly review on Sunday 19:00**: Sunday has its OWN 3/day cap budget (stockholmDateKey is per-Stockholm-day). Weekly review counts as 1-of-3 for Sunday. No special handling.
- **EventBridge Scheduler target for kos.system bus**: the target is the bus ARN + an IAM role with `events:PutEvents`. Cron `0 8/2 ? * MON-FRI *` fires 6 times per weekday → 30 PutEvents/week. Each PutEvents detail is a tiny JSON `{ capture_id: "<scheduler-ulid>", requested_at: "<time>", requested_by: "scheduler" }` matching the Phase-4 `scripts/fire-scan-emails-now.mjs` shape.
- **Calendar data for morning/day-close**: Phase 8 owns CAP-09 Google Calendar integration. **Phase 7 morning-brief initially renders a PLACEHOLDER "(Calendar integration pending Phase 8)"** in the calendar_today/calendar_tomorrow sections IF no calendar data is available in Postgres. A new table `calendar_events` is NOT created in Phase 7 — Phase 8 owns that schema. Brief-renderer tolerates empty calendar arrays cleanly.
- **Dropping the 07:00 → 08:00 move (D-18)**: AUTO-01 spec says "07:00 Stockholm" but the quiet-hours policy forbids sends before 08:00. Moving the schedule to 08:00 respects the invariant cleanly (Option A). Document this in 07-SUMMARY as a spec drift; acceptable in v1.
- **Compliance alarm Lambda**: runs as a standalone Lambda (not inline in verify-script). Lambda reads DynamoDB `TelegramCap` table via `QueryCommand` for last 14 days of pk=`telegram-cap#YYYY-MM-DD` items; also reads `telegram_inbox_queue` rowcount per day. On violation emits SNS via `kos.system / brief.compliance_violation` + returns non-zero exit for operator CLI run. 5-min timeout; minimal memory.
- **No dashboard UI changes in Phase 7**: Phase 3 already renders 🏠 Today page content via Notion API read; once Phase 7 writes fresh content, the dashboard just picks it up on next refresh. Brief history view (reading agent_runs) is a future enhancement.

</specifics>

<deferred>
## Deferred Ideas

- **Morning brief at EXACTLY 07:00 Stockholm** — deferred per D-18; requires coordinated change to quiet-hours end time. Out of Phase 7 scope.
- **Calendar integration in morning brief (CAP-09)** — Phase 8. Phase 7 renders placeholder.
- **Top 3 actioned-state from email_drafts.status=sent or Command Center Status=Klar** — the `acted_on_at` heuristic currently only watches `mention_events`. Tighter signals a future refinement.
- **Weekly retrospective metrics (brief acted-on rate, email triage approval+edit rate)** — Gate 4 metrics live in agent_runs; dashboard page to render them deferred to Phase 9 preparation.
- **Multi-channel briefs (WhatsApp digest, Discord summary)** — Telegram is the primary push channel per Locked #10. Other channels deferred.
- **AI-generated next-week content candidates from market-analyst (AGT-10)** — Phase 9.
- **Dynamic dropped-thread threshold tuning** — hard-coded 24h in D-06 view; future tuning if false-positive rate is high.
- **Brief regeneration on operator demand** — v1 is schedule-only; no on-demand trigger Lambda. Operator can invoke the Lambda directly via AWS CLI for testing.
- **A/B testing brief prompts** — single locked prompt per brief type in v1.

### Reviewed Todos (not folded)
None — STATE.md Active Todos are Phase 1 / Phase 4 / Phase 3 concerns. No Phase-7-shaped pending todo.

</deferred>

---

*Phase: 07-lifecycle-automation*
*Context gathered: 2026-04-24 (no live discussion — defaults locked per orchestrator brief; Kevin asleep)*
