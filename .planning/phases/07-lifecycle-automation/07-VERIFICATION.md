---
phase: 07-lifecycle-automation
verified: 2026-04-25T11:35:00Z
status: human_needed
score: 8/8 must-haves verified
overrides_applied: 0
human_verification:
  - test: "AUTO-01 morning brief delivers at 08:00 Stockholm in production for 5 consecutive weekdays"
    expected: "Kevin receives one Telegram message ~08:00 Stockholm Mon-Fri with prose + Top 3 + calendar + drafts + dropped threads. 🏠 Today Notion page is replaced in-place. Daily Brief Log row appended for each day."
    why_human: "Live cloud deploy + Notion side effects + Telegram delivery cannot be verified at code level — requires `cdk deploy` + observation in production for 5 days."
  - test: "Notification cap holds for 14 consecutive days in production"
    expected: "Kevin never receives more than 3 Telegram messages/day from KOS over 14 days. Items above cap queue silently to telegram_inbox_queue (never silently lost). The Sunday 03:00 Stockholm verify-notification-cap Lambda runs and reports healthy on its first 2 invocations."
    why_human: "Requires 14 days of live operation + DynamoDB TelegramCap observation; static analysis has confirmed the IAM/SQL/SNS plumbing but not the runtime invariant."
  - test: "Quiet hours respected — zero pushes between Stockholm 20:00–08:00 over 14 days"
    expected: "agent_runs filtered to agent_name='push-telegram' has zero rows where Stockholm-local hour is in [20, 8). The verify-quiet-hours-invariant.mjs script returns exit 0 against live DB."
    why_human: "Live RDS query needed; must observe real push-telegram runs over 14d window."
  - test: "AUTO-03 day-close brief delivers at 18:00 Stockholm and updates Kevin Context page"
    expected: "Kevin sees a single Telegram evening summary at 18:00 Stockholm Mon-Fri; Daily Brief Log accretes a 'day-close' row; Kevin Context page appends 'Recent decisions (YYYY-MM-DD)' + 'Slipped items (YYYY-MM-DD)' heading_2 sections (append-only, never destructive)."
    why_human: "Live Notion API + scheduled cron + Telegram delivery; static analysis confirms code path."
  - test: "AUTO-04 weekly-review delivers Sunday 19:00 Stockholm and overwrites Kevin Context Active Threads section"
    expected: "Kevin receives one Telegram weekly recap at 19:00 Stockholm Sunday; Kevin Context page 'Active threads' heading_2 section is replaced with fresh content (existing section archived, new section appended); Daily Brief Log gets a 'weekly-review' row."
    why_human: "Notion replace-in-place semantics under live concurrent edits cannot be simulated; requires production observation. T-07-WEEKLY-01 (heading detection) was unit-tested but live page diversity is the only true signal."
  - test: "loadContext + Azure Search hybridQuery returns useful dossier for hot entities at 08:00"
    expected: "Morning brief prose mentions specific entities (Damien, Christina, Almi, etc.) by name with accurate recent context — i.e., the dossier injection is not just structural but semantically useful. Sonnet 4.6 produces a calm prose summary that reads well."
    why_human: "Brief quality is a subjective judgment; requires Kevin to read the brief and confirm 'I never had to re-explain context'."
---

# Phase 7: Lifecycle Automation Verification Report

**Phase Goal:** AUTO-01..AUTO-04 lifecycle agents — daily/weekly rhythm. Morning brief, day-close brief, weekly review, email-triage every-2h. All respect Phase 1 notification cap (3/day) + quiet-hours (20:00–08:00 Stockholm). Each brief is one Sonnet 4.6 Bedrock invocation using `@kos/context-loader::loadContext()` (Phase 6) for full entity awareness, structured output via Bedrock `tool_use`.

**Verified:** 2026-04-25T11:35:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | AUTO-01 morning-brief: cron `0 8 ? * MON-FRI *` Europe/Stockholm; loadContext + Sonnet 4.6 tool_use; writes 🏠 Today + Daily Brief Log + emits ONE output.push | VERIFIED | integrations-lifecycle.ts:197-198 cron + timezone; handler.ts:35,36,117,210 loadContext + hybridQuery + PutEvents output.push; agent.ts:33 SONNET_4_6_MODEL_ID; agent.ts:235 tool_choice forced record_morning_brief; handler.ts:117 calls loadContext; D-18 documented 07→08 drift |
| 2 | AUTO-02 email-triage scheduler: cron `0 8/2 ? * MON-FRI *` Stockholm PutEvents to kos.system bus DetailType=scan_emails_now (zero Lambda code) | VERIFIED | integrations-lifecycle.ts:388 cron + 389 timezone + 402-407 EventBridge bus target with detailType=scan_emails_now + 384 grantPutEventsTo; CDK test "Plan 07-03: emailTriageSchedulerRole has events:PutEvents on systemBus (and NOT lambda:InvokeFunction)" passes |
| 3 | AUTO-03 day-close: cron `0 18 ? * MON-FRI *` Stockholm; same loadContext + Sonnet pipeline; updates Kevin Context | VERIFIED | integrations-lifecycle.ts:278-279 cron + Stockholm; day-close/handler.ts:39,125,226 loadContext + PutEvents; agent.ts:188+226 record_day_close_brief tool_choice; notion.ts:153 appendKevinContextSections (Recent decisions + Slipped items append-only) |
| 4 | AUTO-04 weekly-review: cron `0 19 ? * SUN *` Stockholm; same pipeline; replaces Active Threads section on Kevin Context | VERIFIED | integrations-lifecycle.ts:298-299 cron + Stockholm; weekly-review/handler.ts:37,140,203 loadContext + PutEvents; agent.ts:54 record_weekly_review tool_choice; notion.ts:111 replaceActiveThreadsSection (heading_2 detection + archive + append) |
| 5 | Notification cap (D-07): verify-notification-cap Lambda runs weekly, asserts no day in last 14 has >3 pushes; SNS alarmTopic on violation | VERIFIED | verify-notification-cap/handler.ts:38 SNSClient import + line 14-15 SNS publish on violation + brief.compliance_violation; queries.ts:loadCapSnapshots14Days returns 14 entries; integrations-lifecycle.ts:351-352 cron(0 3 ? * SUN *) Stockholm; CDK test verifies sns:Publish on alarmTopic + dynamodb:GetItem (NOT write) + rds-db:connect on kos_admin |
| 6 | Quiet hours invariant: scripts/verify-quiet-hours-invariant.mjs asserts zero output.push where Stockholm localHour ∈ [20, 8); D-18 morning-brief at 08:00 (not 07:00) honors invariant | VERIFIED | scripts/verify-quiet-hours-invariant.mjs (77 lines, parses node --check OK); push-telegram/quiet-hours.ts:33 returns h>=20\|\|h<8; morning-brief schedule confirmed at 08:00 Stockholm via integrations-lifecycle.ts:197 (D-18 drift documented in 07-CONTEXT.md + 07-01-SUMMARY.md) |
| 7 | loadContext integration (AGT-04 from Phase 6): all 3 brief Lambdas call loadContext with azureSearch=hybridQuery for full entity awareness | VERIFIED | morning-brief/handler.ts:35-36 imports loadContext + hybridQuery; day-close/handler.ts:39-40 same; weekly-review/handler.ts:37-38 same; all three call loadContext({ entityIds, agentName, captureId, ownerId, pool, azureSearch: ... }) at handler.ts:117/125/140 respectively |
| 8 | Migration 0014: dropped_threads_v view + top3_membership table + acted_on_at trigger | VERIFIED | 0014_phase_7_top3_and_dropped_threads.sql:26-37 CREATE TABLE top3_membership; lines 64-83 CREATE OR REPLACE VIEW dropped_threads_v with mention_events JOIN; lines 93-107 mark_top3_acted_on() + AFTER INSERT trigger on mention_events |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `services/morning-brief/src/handler.ts` | AUTO-01 orchestrator | VERIFIED | 320 lines; loadContext + hybridQuery + writeTop3Membership + Notion + output.push |
| `services/morning-brief/src/agent.ts` | Sonnet 4.6 tool_use | VERIFIED | 292 lines; AnthropicBedrock + EU profile + tool_choice forced |
| `services/morning-brief/src/hot-entities.ts` | Top-10 hot entities by 48h mention count (D-17) | VERIFIED | 43 lines; SQL group-by-count |
| `services/morning-brief/src/persist.ts` | agent_runs idempotency + top3_membership writes | VERIFIED | 223 lines; SELECT-before-INSERT + writeTop3Membership |
| `services/morning-brief/src/notion.ts` | 🏠 Today replace-in-place + Daily Brief Log append | VERIFIED | 132 lines; semaphore-3 archive pacing |
| `services/day-close/src/handler.ts` | AUTO-03 orchestrator | VERIFIED | 338 lines; same shape + Kevin Context append |
| `services/day-close/src/agent.ts` | Sonnet 4.6 record_day_close_brief | VERIFIED | 283 lines |
| `services/day-close/src/notion.ts` | replace 🏠 Today + Daily Brief Log + appendKevinContextSections | VERIFIED | 208 lines; appendKevinContextSections (line 153) is append-only |
| `services/day-close/src/persist.ts` | persist + slipped items + decisions hint | VERIFIED | 254 lines |
| `services/weekly-review/src/handler.ts` | AUTO-04 orchestrator | VERIFIED | 308 lines; 7-day window |
| `services/weekly-review/src/agent.ts` | Sonnet 4.6 record_weekly_review (no top_three) | VERIFIED | 237 lines |
| `services/weekly-review/src/notion.ts` | Daily Brief Log + replaceActiveThreadsSection | VERIFIED | 194 lines; heading_2 detection + archive + append (T-07-WEEKLY-01 mitigation) |
| `services/weekly-review/src/persist.ts` | hot entities (7d, top 20) + week recap hint | VERIFIED | 200 lines; no writeTop3Membership (D-05 — schema has no top_three) |
| `services/verify-notification-cap/src/handler.ts` | weekly cap-invariant + quiet-hours Lambda | VERIFIED | 199 lines; SNS publish + brief.compliance_violation; never throws |
| `services/verify-notification-cap/src/queries.ts` | loadCapSnapshots14Days + loadQuietHoursViolations14Days | VERIFIED | 173 lines; Stockholm 14-day window in JS; DynamoDB GetItem swallowed on failure |
| `services/verify-notification-cap/src/pool.ts` | RDS Proxy IAM-auth pool | VERIFIED | 42 lines |
| `services/_shared/brief-renderer.ts` | renderNotionTodayBlocks + renderDailyBriefLogPage + renderTelegramHtml | VERIFIED | 485 lines; pure-function shared by all 3 briefs |
| `packages/contracts/src/brief.ts` | MorningBrief + DayClose + WeeklyReview Zod schemas | VERIFIED | 152 lines; 5 schema exports + BriefAgentRunOutputSchema with brief_kind discriminator |
| `packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql` | top3_membership + dropped_threads_v + trigger | VERIFIED | 112 lines |
| `packages/cdk/lib/stacks/integrations-lifecycle.ts` | wireLifecycleAutomation helper with 5 schedules | VERIFIED | 430 lines; all 5 cron + Stockholm timezone present (lines 197/278/298/351/388) |
| `scripts/verify-phase-7-e2e.mjs` | Phase 7 E2E gate (mock + live) | VERIFIED | 480 lines; mock mode runs 13 structural checks (13/13 PASS) |
| `scripts/verify-notification-cap-14day.mjs` | CLI-runnable cap verifier | VERIFIED | 112 lines; node --check parses OK |
| `scripts/verify-quiet-hours-invariant.mjs` | CLI-runnable quiet-hours verifier | VERIFIED | 77 lines; node --check parses OK |

### Key Link Verification

| From | To | Via | Status |
|------|----|----|--------|
| morning-brief/handler.ts | @kos/context-loader::loadContext | import + call at handler.ts:117 | WIRED |
| morning-brief/handler.ts | @kos/azure-search::hybridQuery | import at line 36; passed as `azureSearch:` to loadContext at line 124 | WIRED |
| morning-brief/handler.ts | top3_membership (DB) | persist.writeTop3Membership at handler.ts:162 | WIRED |
| morning-brief/handler.ts | dropped_threads_v (DB) | persist.loadDroppedThreads (uses SELECT FROM dropped_threads_v) | WIRED |
| morning-brief/handler.ts | kos.output bus | EventBridge PutEventsCommand at handler.ts:210; DetailType=output.push | WIRED |
| day-close/handler.ts | Kevin Context page (Notion) | notion.appendKevinContextSections (Recent decisions + Slipped items) | WIRED |
| weekly-review/handler.ts | Kevin Context page (Notion) | notion.replaceActiveThreadsSection (heading_2 archive + append) | WIRED |
| EventBridge Scheduler email-triage-every-2h | kos.system / scan_emails_now | target.arn=systemBus.eventBusArn + eventBridgeParameters detailType+source | WIRED |
| verify-notification-cap | SafetyStack alarmTopic | SNSClient.publish at handler.ts:120 (TopicArn=ALARM_TOPIC_ARN) | WIRED |
| verify-notification-cap | kos.system / brief.compliance_violation | EventBridge PutEvents on violation (best-effort) | WIRED |
| All brief Lambdas | Sonnet 4.6 EU profile via Bedrock | AnthropicBedrock SDK + SONNET_4_6_MODEL_ID + tool_choice forced | WIRED |
| Migration 0014 trigger | mention_events INSERT | AFTER INSERT trigger trg_mark_top3_acted_on calls mark_top3_acted_on() | WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| verify-phase-7-e2e --mock returns 13/13 PASS | `node scripts/verify-phase-7-e2e.mjs --mock` | "Result: PASS (13/13)" | PASS |
| verify-notification-cap unit tests | `pnpm --filter @kos/service-verify-notification-cap test` | Test Files 2 passed (2); Tests 8 passed (8) | PASS |
| morning-brief unit tests | `pnpm --filter @kos/service-morning-brief test` | Test Files 5 passed (5); Tests 26 passed (26) | PASS |
| day-close unit tests | `pnpm --filter @kos/service-day-close test` | Test Files 3 passed (3); Tests 9 passed (9) | PASS |
| weekly-review unit tests | `pnpm --filter @kos/service-weekly-review test` | Test Files 4 passed (4); Tests 11 passed (11) | PASS |
| CDK integrations-lifecycle | `pnpm --filter @kos/cdk test -- integrations-lifecycle` | Test Files 1 passed (1); Tests 21 passed (21) | PASS |
| Quiet-hours CLI parses cleanly | `node --check scripts/verify-quiet-hours-invariant.mjs` | exit 0 | PASS |
| Quiet-hours CLI errors usefully without DB | `node scripts/verify-quiet-hours-invariant.mjs` | "verify-quiet-hours-invariant: DATABASE_URL not set." (exit 2) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|------------|-------------|-------------|--------|----------|
| AUTO-01 | 07-01 | 07:00 Stockholm — Morning brief: prose + Top 3 + calendar + drafts ready + dropped threads → 🏠 Today + Telegram | SATISFIED | services/morning-brief/* + integrations-lifecycle.ts:197 cron(0 8 ? * MON-FRI *) Europe/Stockholm. **Note:** Schedule moved to 08:00 (not 07:00) to honor quiet-hours invariant — D-18 documented drift. AUTO-01 still has `[ ]` checkbox at REQUIREMENTS.md:83 (documentation drift; implementation complete). |
| AUTO-02 | 07-03 | Every 2h weekdays 08:00–18:00 — Email triage runs on both accounts | SATISFIED | integrations-lifecycle.ts:388 cron(0 8/2 ? * MON-FRI *) Stockholm + PutEvents kos.system/scan_emails_now; Phase 4 owns the consumer Lambda. REQUIREMENTS.md:84 marked `[x]`. |
| AUTO-03 | 07-02 | 18:00 Stockholm — Day close: Daily Brief Log + Kevin Context updates + slipped items + Telegram | SATISFIED | services/day-close/* + integrations-lifecycle.ts:278 cron(0 18 ? * MON-FRI *) Stockholm. REQUIREMENTS.md:86 marked `[x]`. |
| AUTO-04 | 07-02 | Sunday 19:00 — Weekly review: full week recap + next-week candidates → Kevin Context + Telegram | SATISFIED | services/weekly-review/* + integrations-lifecycle.ts:298 cron(0 19 ? * SUN *) Stockholm. REQUIREMENTS.md:88 marked `[x]`. |

**Documentation drift finding:** `.planning/REQUIREMENTS.md` line 83 still has `- [ ]` for AUTO-01 (should be `[x]` like AUTO-02..04 which were already updated). The phase-progress table at REQUIREMENTS.md:202–205 also still shows all 4 AUTO-0X as "Pending" — it has not been updated to reflect Phase 7 completion. This is documentation drift, not a code gap. Suggested update is informational; no plan needed.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| services/day-close/src/persist.ts | 227 | Comment "placeholder hint and Sonnet infers from broader context." | Info | Comment about an empty array fallback when decisions hint query returns []; Sonnet still produces a brief from broader context. Not a stub — this is intentional graceful-degrade pattern. |
| services/morning-brief/src/persist.ts | (loadDraftsReady) | SQLSTATE 42P01 catch returning [] | Info | Phase-4 graceful degrade — email_drafts table doesn't yet exist; brief renders cleanly with empty drafts. Documented in 07-01-SUMMARY decisions. Will start populating once Phase 4 ships its email_drafts migration. |

No blockers. No stubs. No empty handlers. Two intentional info-level findings documented as graceful degrades.

### Human Verification Required

See `human_verification:` in frontmatter for the 6 items requiring live observation.

These are inherent for Phase 7:
1. Live cron firing at 08:00 / 18:00 / 19:00 Stockholm cannot be validated statically.
2. Real Notion side-effects (replace-in-place, Kevin Context updates) require an actual Notion workspace.
3. Notification cap holding for 14 consecutive days requires 14 days of operation.
4. Brief quality (does the prose feel calm? does Kevin recognize the entities?) is subjective.
5. Telegram delivery + 4096-char limit truncation under real brief length.

The static verification harness (`verify-phase-7-e2e.mjs --mock`, 13/13 PASS) validates everything that can be statically verified.

### Gaps Summary

No blocking gaps. All 8 observable truths verified at code level. All 4 AUTO requirements have working implementation paths. All 23 required artifacts exist with substantive line counts and proper wiring. All key links are wired (component → API, API → DB, scheduler → bus, brief → Notion).

The phase has fully and correctly implemented the goal at the code level. Six items remain that require live cloud deploy + observation to confirm production behavior — these are inherent to the phase and cannot be eliminated by additional code work.

---

_Verified: 2026-04-25T11:35:00Z_
_Verifier: Claude (gsd-verifier)_
