---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-24T00:00:00.000Z"
progress:
  total_phases: 10
  completed_phases: 1
  total_plans: 42
  completed_plans: 20
  percent: 57
---

# State: Kevin OS (KOS)

**Initialized:** 2026-04-21
**Last updated:** 2026-04-21

---

## Project Reference

**Core value:** Kevin never has to re-explain context. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

**Current focus:** Phase 01 — infrastructure-foundation

**North-star user behavior (v1 acceptance, Gate 4):** 4 continuous weeks of daily KOS use, morning brief acted on 5 days/week, entity resolver > 90% accuracy on voice, email triage approval+edit rate > 70%, dashboard > 3 sessions/week.

---

## Current Position

Phase: 01 (infrastructure-foundation) — EXECUTING
Plan: 1 of 9
**Phase:** 1 — Infrastructure Foundation
**Plan:** Not yet planned (run `/gsd-plan-phase 1`)
**Status:** Ready to execute
**Progress:** [░░░░░░░░░░] 0/10 phases complete

```
Phase 1: [ ] Infrastructure Foundation       ◀── CURRENT
Phase 2: [ ] Minimum Viable Loop             (depends on 1)
Phase 3: [ ] Dashboard MVP                   (depends on 2; ‖ with 4)
Phase 4: [ ] Email Pipeline + iOS Capture    (depends on 1,2; ‖ with 3)
Phase 5: [ ] Messaging Channels              (depends on 2,3)
Phase 6: [ ] Granola + Semantic Memory       (depends on 1,2)
Phase 7: [ ] Lifecycle Automation            (depends on 6,4,3)
Phase 8: [ ] Outbound Content + Calendar     (depends on 6,5)
Phase 9: [ ] V2 Specialty Agents             (BLOCKED — Gate 4)
Phase 10:[ ] Migration & Decommission        (depends on 7; ‖ with 6-8)
```

---

## Performance Metrics

**Roadmap creation:**

- Phases derived: 10 (research-aligned, validated against requirements coverage)
- Requirements mapped: 54/54 (100%)
- Hard gates defined: 5 (Gate 1–5 + AGT-11 DPIA gate)

**Production targets (Gate 4):**

- Entity resolver accuracy on voice: > 90%
- Email triage approval+edit rate: > 70%
- Dashboard sessions: > 3/week
- Daily-use streak required: 28 consecutive days

**Cost target:** $200–400/month all-in. AWS $20k + Azure $5k + Google $2k credits cover ~12–18 months.

---

## Accumulated Context

### Locked Decisions (carry across all phases)

1. **EventBridge-only event routing** — n8n decommissioned in Phase 10; captures publish, never call agents directly.
2. **Notion = source of truth, Postgres = derived index** — agents write Notion first, `notion-indexer` upserts Postgres async.
3. **Claude Agent SDK on Lambda** — subagents as `.agents/*.md` files; Bedrock-native via `CLAUDE_CODE_USE_BEDROCK=1`; not LangGraph/CrewAI.
4. **Lambda for events, Fargate for persistent connections** — EmailEngine, Baileys, Postiz are separate Fargate tasks (never co-located).
5. **RDS PostgreSQL 16 (db.t4g.medium, eu-north-1, reserved)** — pgvector enabled; not Aurora Serverless v2 (HNSW issues + 17% cost premium).
6. **Azure AI Search Basic-tier with binary quantization at index creation** — 92.5% cost reduction vs default (~$75/mo not $1,000/mo).
7. **SSE via Postgres LISTEN/NOTIFY from Next.js Edge** — not AppSync, not Pusher.
8. **Static Bearer token in Secrets Manager for dashboard auth** — single-user, no Cognito/Clerk.
9. **AWS Transcribe `sv-SE` with custom vocabulary mandatory** — fallback to self-hosted Whisper large-v3 if WER ≥ 15% on real Kevin voice.
10. **Telegram = mobile push, dashboard = desktop primary** — iOS 17.4 EU DMA removed standalone PWA push; cannot engineer around.
11. **Hard cap of 3 Telegram messages/day** — enforced at infrastructure level in Phase 1, not as a Phase 7 lifecycle concern.
12. **Archive-never-delete policy** — implemented in `notion-indexer` from Phase 1; merges copy then archive, never delete.
13. **`owner_id` on every RDS table** — single-user today, trivializes multi-user later. Forward-compat at zero cost.
14. **V2 specialty agents BLOCKED behind Gate 4** — specs may be written; code cannot ship. AGT-11 additionally requires DPIA per EU AI Act August 2026.

### Open Questions (carry into Phase 1)

1. Bedrock model regional availability: confirm Sonnet 4.6 + Haiku 4.5 in eu-north-1 vs us-east-1 (impacts GDPR data flow).
2. AWS Transcribe `sv-SE` in eu-north-1 — confirm streaming + batch availability.
3. Claude Agent SDK `cache_control` on Bedrock — token-limit parity with Anthropic API direct.
4. Notion workspace EU data residency — confirm current plan supports it; upgrade if needed before Phase 1 close.
5. EmailEngine licensing — procure $99/year license before Phase 4 begins.
6. Vercel Hobby SSE stream limits (30s vs Pro 300s) — evaluate Pro vs `fluid compute` vs Fargate `next-start` before Phase 3 ships.

### Active Todos

- [ ] Plan Phase 1 (`/gsd-plan-phase 1`)
- [ ] Confirm Bedrock model availability in target region (open question 1)
- [ ] Confirm Notion workspace EU data residency (open question 4)
- [ ] Procure EmailEngine license (Phase 4 prereq)

### Blockers

- None at roadmap stage.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260423-vra | Fix audit H1 + H2: route dashboard /capture through triage, clean up Cohere v3 test drift | 2026-04-23 | 57dc08f | [260423-vra-fix-audit-h1-h2-route-dashboard-capture-](./quick/260423-vra-fix-audit-h1-h2-route-dashboard-capture-/) |

Last activity: 2026-04-23 - Completed quick task 260423-vra (H1 dashboard Composer dead-letter + H2 Cohere v3 test drift cleanup)

---

## Session Continuity

**Last session (2026-04-21):**

- Initialized PROJECT.md, REQUIREMENTS.md (54 v1 requirements, 4 v2 deferred).
- Completed deep research: SUMMARY.md, STACK.md, ARCHITECTURE.md, PITFALLS.md.
- Created ROADMAP.md (this session): 10 phases, 54/54 coverage, 5 hard gates.

**Next session:**

- Run `/gsd-plan-phase 1` to decompose Phase 1 into executable plans.
- Suggested plan slices for Phase 1: (a) AWS account + CDK baseline + VPC + IAM, (b) RDS + S3 + VPC Gateway Endpoint + Secrets Manager, (c) 5 EventBridge buses + DLQs + cost alarms, (d) Notion Entities + Projects DBs + `notion-indexer` Lambda, (e) Azure AI Search index with binary quantization, (f) AWS Transcribe custom vocabulary, (g) VPS freeze + Legacy Inbox redirect + archive-not-delete policy, (h) Notification cap enforcement at push-Lambda layer.

---

*State initialized: 2026-04-21*

## Session Continuity Addendum (2026-04-24)

**Phase 6 planned:** `/gsd-plan-phase 6` (run 2026-04-24, Kevin asleep — recommended defaults locked) produced:
- 06-CONTEXT.md (28 D-XX decisions; all four gray-area defaults accepted)
- 06-RESEARCH.md (Bedrock cache_control, Notion last_edited_time caveats, PG MV CONCURRENTLY, Vertex 32k floor, Azure semantic reranker pricing)
- 06-VALIDATION.md (Nyquist-compliant matrix; 24 tasks across 7 plans)
- 7 PLAN files (06-00 scaffold, 06-01 granola-poller, 06-02 transcript-extractor, 06-03 azure-search-indexers, 06-04 entity-timeline-mv-refresher, 06-05 context-loader+dossier-loader, 06-06 gate verifier)
- 06-DISCUSSION-LOG.md + deferred-items.md

**Status:** Phase 6 plans READY (NOT yet executing). Operator can run `/gsd-execute-phase 6` after reviewing 06-CONTEXT.md.

**Notable architectural lock:** AGT-04 redesigned per Locked Decision #3 revision (2026-04-23) as an explicit `@kos/context-loader` library helper, NOT an Agent-SDK pre-call hook. All four consumer Lambdas (triage, voice-capture, entity-resolver, transcript-extractor) call `loadContext()` before their Bedrock invocation; Phase 4 + 7 + 8 will inherit the same pattern.

**Next session:** Operator pre-deploy actions documented in deferred-items.md (GCP project, Vertex SA, Notion Transkripten DB discovery). Phase 6 execution will write to `packages/context-loader/`, `packages/azure-search/`, 8 new `services/*` directories, `packages/db/drizzle/0012_*.sql`, and `packages/cdk/lib/stacks/integrations-{granola,azure-indexers,mv-refresher,vertex}.ts`.

## Session Continuity Addendum (2026-04-24 — Phase 4)

**Phase 4 planned:** `/gsd-plan-phase 4` (run 2026-04-24, same session as Phase 6 planning — Kevin asleep, recommended defaults locked per orchestrator brief) produced:
- 04-CONTEXT.md (30 D-XX decisions; all 7 gray-area defaults accepted — EmailEngine on Fargate + ElastiCache Serverless; HMAC-SHA256 iOS auth; SES inbound in eu-west-1 with cross-region; Haiku classify + Sonnet draft; composite (account_id, message_id) idempotency; dashboard-api Route Handlers; email-sender separated from email-triage)
- 04-RESEARCH.md (SES region asymmetry, EmailEngine docker constraints, iOS Shortcut HMAC actions, Bedrock prompt-injection delimiters, Gmail app passwords, SES sandbox, 12 pitfalls)
- 04-VALIDATION.md (Nyquist-compliant; 28 automated tasks + 4 operator-only manual verifications)
- 7 PLAN files (04-00 scaffold, 04-01 ios-webhook, 04-02 ses-inbound, 04-03 emailengine Fargate, 04-04 email-triage, 04-05 email-sender + dashboard routes, 04-06 Gate 3 + E2E verifiers)
- 04-DISCUSSION-LOG.md + 04-SES-OPERATOR-RUNBOOK.md + 04-EMAILENGINE-OPERATOR-RUNBOOK.md + 04-06-GATE-3-evidence-template.md

**Cross-region SES decision:** Parked SES inbound in **eu-west-1**. Not eu-north-1 (unsupported). Not moving all of KOS to eu-west-1 (6-month replatform). Lambda ses-inbound reads S3 cross-region (~$0.01/mo data transfer). Documented in 04-SES-OPERATOR-RUNBOOK.md; bucket + receiving rule are operator-created (no CDK in eu-west-1 this phase).

**Phase 4 / Phase 6 migration number collision guard:** both phases author a `0012_*.sql` migration. Plan 04-00 Task 3 includes a next-number check — if Phase 6's 0012 lands first at execution time, Phase 4 bumps to 0013. No planner-time conflict.

**Status:** Phase 4 plans READY (NOT yet executing). Operator can run `/gsd-execute-phase 4` after reviewing 04-CONTEXT.md + procuring EmailEngine license + generating Gmail app passwords.

**Deviations from recommended defaults:** None. All 7 gray-area orchestrator recommendations accepted verbatim.

**Next session:** Operator pre-deploy actions:
1. Procure EmailEngine $99/yr license.
2. Generate Gmail app passwords for both accounts.
3. Verify kos.tale-forge.app in SES eu-west-1 + publish MX record.
4. Seed 6 Secrets Manager entries via scripts/seed-secrets.sh.
5. Request SES production access (support case).
6. Run `/gsd-execute-phase 4` — Phase 4 writes to `services/{ios-webhook,ses-inbound,emailengine-webhook,emailengine-admin,email-triage,email-sender}`, `packages/contracts/src/email.ts`, `packages/db/drizzle/0012_or_0013_phase_4_*.sql`, `packages/cdk/lib/stacks/integrations-{ios-webhook,ses-inbound,emailengine,email-agents}.ts`, 3 new Next.js Route Handlers in `apps/dashboard/src/app/api/email-drafts/`, 2 verifier scripts, evidence template.

**Plan path:** `.planning/phases/04-email-pipeline-ios-capture/04-CONTEXT.md`.

## Session Continuity Addendum (2026-04-24 — Phase 7)

**Phase 7 planned:** `/gsd-plan-phase 7` (run 2026-04-24, same session as Phase 6 + Phase 4 planning — Kevin asleep, all 7 recommended defaults locked per orchestrator brief) produced:
- 07-CONTEXT.md (19 D-XX decisions; all 7 gray-area orchestrator defaults accepted verbatim — Sonnet 4.6 throughout; BOTH 🏠 Today + Daily Brief Log; Europe/Stockholm native cron; shared `@kos/contracts/src/brief.ts` Zod schemas; `dropped_threads_v` SQL view + `top3_membership` table; weekly cap-invariant Lambda via Scheduler; single Telegram HTML message per brief)
- 07-RESEARCH.md (EventBridge Scheduler timezone/DST semantics, AWS cron 6-field + `?` wildcard, Bedrock tool_use + tool_choice, Notion replace-in-place 3-RPS budget, Telegram HTML parse_mode 4096-char limit, AnthropicBedrock EU inference profile)
- 07-VALIDATION.md (Nyquist-compliant matrix; 14 tasks across 5 plans)
- 5 PLAN files (07-00 scaffold, 07-01 morning-brief + brief-renderer + 08:00 schedule, 07-02 day-close + weekly-review, 07-03 AUTO-02 scheduler-only, 07-04 verify-notification-cap + 3 CLI verifiers + E2E gate)
- 07-DISCUSSION-LOG.md

**D-18 spec drift (documented):** AUTO-01 ROADMAP spec says 07:00 Stockholm; Phase-1 `services/push-telegram/src/quiet-hours.ts` asserts `h >= 20 || h < 8` as quiet. 07:00 falls INSIDE the quiet window. Resolution = Option A: morning-brief schedule = `cron(0 8 ? * MON-FRI *)` Europe/Stockholm. 08:00 drift documented in ROADMAP §Phase 7 SC1 and 07-01 PLAN. Restoring 07:00 is deferred to a future polish pass requiring a coordinated change to `quiet-hours.ts` (`h < 7` end).

**Migration number collision (Phase 4 / 6 / 7 guard):** Phase 6 reserves 0012, Phase 4 reserves 0012 with bump-to-0013 on Phase-6-first-land, Phase 7 reserves 0014. At execution time, Phase 7 plan 07-00 Task 3 includes a next-available check — if the filesystem state doesn't match the expected chain (0012 Phase-6, 0013 Phase-4, 0014 Phase-7), executor bumps accordingly.

**Status:** Phase 7 plans READY (NOT yet executing). Operator can run `/gsd-execute-phase 7` after:
1. Confirming Phase 6 + Phase 4 plans have landed (loadContext + scan_emails_now rule must exist at runtime).
2. Seeding `scripts/.notion-db-ids.json` with `todayPage` (🏠 Today page id) + `dailyBriefLog` (Daily Brief Log DB id).
3. Verifying Daily Brief Log DB in Kevin's Notion workspace has `Type` (select: morning/day-close/weekly-review) + `Date` (date) properties.

**Deviations from recommended defaults:** None. All 7 gray-area orchestrator recommendations accepted verbatim. The D-18 08:00 drift is a reconciliation with the Phase-1 quiet-hours invariant, not a deviation from the orchestrator brief (which explicitly flagged the invariant as load-bearing).

**Plan path:** `.planning/phases/07-lifecycle-automation/07-CONTEXT.md`.

**Next session:** Operator pre-deploy actions:
1. Confirm Phase 6 execution before Phase 7 (loadContext dependency).
2. Seed Notion page/DB IDs as above.
3. Run `/gsd-execute-phase 7` — Phase 7 writes to `services/{morning-brief,day-close,weekly-review,verify-notification-cap}`, `services/_shared/brief-renderer.ts`, `packages/contracts/src/brief.ts`, `packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql`, `packages/cdk/lib/stacks/integrations-lifecycle.ts`, and 3 new `scripts/verify-*.mjs` verifiers.
