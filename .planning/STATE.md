---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-25T10:56:48.759Z"
last_activity: 2026-04-25
progress:
  total_phases: 11
  completed_phases: 3
  total_plans: 80
  completed_plans: 48
  percent: 60
---

# State: Kevin OS (KOS)

**Initialized:** 2026-04-21
**Last updated:** 2026-04-21

---

## Project Reference

**Core value:** Kevin never has to re-explain context. Every input gets routed automatically. Every output is context-aware. The system maintains itself; Kevin only writes raw input and reads curated output.

**Current focus:** Phase --phase — 07

**North-star user behavior (v1 acceptance, Gate 4):** 4 continuous weeks of daily KOS use, morning brief acted on 5 days/week, entity resolver > 90% accuracy on voice, email triage approval+edit rate > 70%, dashboard > 3 sessions/week.

---

## Current Position

Phase: --phase (07) — EXECUTING
Plan: 1 of --name
**Phase:** 1 — Infrastructure Foundation
**Plan:** Not yet planned (run `/gsd-plan-phase 1`)
**Status:** Executing Phase --phase
**Progress:** [██████░░░░] 57%

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
| 260424-pxt | Fix dashboard sidebar 404 — add /entities list RSC reusing getPaletteEntities() | 2026-04-24 | 522897c | [260424-pxt-fix-dashboard-sidebar-404-create-apps-da](./quick/260424-pxt-fix-dashboard-sidebar-404-create-apps-da/) |
| 260424-q93 | Remove orphan aws4fetch dead code from dashboard after Bearer auth migration | 2026-04-24 | 5c5edff | [260424-q93-remove-orphan-aws4fetch-dead-code-from-d](./quick/260424-q93-remove-orphan-aws4fetch-dead-code-from-d/) |
| 260424-r6s | Migrate dashboard PWA from @serwist/next to @serwist/turbopack for Next 16 (sw URL: `/sw.js` → `/serwist/sw.js`, Vercel preview verified 200 OK) | 2026-04-24 | 4b4c906 | [260424-r6s-migrate-dashboard-pwa-from-serwist-next-](./quick/260424-r6s-migrate-dashboard-pwa-from-serwist-next-/) |

Last activity: 2026-04-25

---
| Phase 06-granola-semantic-memory P09 | 9 | 2 tasks | 2 files |
| Phase 07 P00 | 24 | 4 tasks | 21 files |
| Phase 07 P03 | 21 | 1 tasks | 2 files |
| Phase 07 P02 | 19 | 3 tasks | 17 files |

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

## Session Continuity Addendum (2026-04-24 — Phase 8)

**Phase 8 planned:** `/gsd-plan-phase 8` (run 2026-04-24, same overnight session as Phase 6/4/7 — Kevin asleep, all 7 orchestrator-recommended defaults locked verbatim) produced:

- 08-CONTEXT.md (33 D-XX decisions; 7 gray-area defaults accepted — BRAND_VOICE.md seed w/ human_verification gate; Step Functions Standard Map; Postiz Fargate 0.5 vCPU + EFS; OAuth per-account refresh tokens; regex→Haiku→Sonnet 3-stage; (recipient_email, doc_name) composite key; separate tables+events for mutation vs content)
- 08-RESEARCH.md (Postiz MCP Streamable HTTP, Google Calendar v3, Step Functions Standard vs Express, pdf-parse/mammoth extraction, Swedish+English imperative linguistics, Fargate Postiz deployment, 15 pitfalls)
- 08-VALIDATION.md (Nyquist-compliant; 21 tasks across 7 plans; 10 TDD tasks)
- 7 PLAN files (08-00 scaffold, 08-01 calendar-reader+context-loader extension, 08-02 content-writer+Step Functions, 08-03 publisher+Postiz Fargate+dashboard routes [human-action checkpoint], 08-04 mutation-proposer+mutation-executor [SC 6], 08-05 document-diff+entity-timeline extension, 08-06 gate verifiers+evidence)
- 08-DISCUSSION-LOG.md

**SC 6 (imperative-verb mutation pathway) scope:** Two dedicated Lambdas (services/mutation-proposer + services/mutation-executor) with 3-stage classifier (regex pre-filter → Haiku classification → Sonnet target decision) + pending_mutations DB table + dashboard Approve route + archive-not-delete applier. voice-capture race-fix via hasPendingMutation check. The 2026-04-23 failure case ("ta bort mötet imorgon kl 11") is now a pending Inbox card requiring explicit Approve; no silent CC insertion.

**Approve-gate structural invariants (SC 5) — 6 Lambda IAM split:**

- content-writer: NO postiz, NO ses
- publisher: NO bedrock, NO ses
- mutation-proposer: NO postiz, NO ses, NO notion writes
- mutation-executor: NO bedrock, NO postiz, NO ses, NO google-calendar, NO DELETE grants anywhere
- document-diff: NO postiz, NO ses, NO notion writes
- calendar-reader: NO bedrock, NO writes of any kind outside calendar_events_cache

CDK tests grep synth output for forbidden actions; zero-match enforced mechanically.

**Migration number collision guard:** Phase 6 reserves 0012, Phase 4 reserves 0012→0013, Phase 7 reserves 0014, Phase 8 targets 0015 with bump-to-0016 guard.

**D-17 Google Calendar read-only invariant:** OAuth scope locked to `calendar.readonly`; mutation-executor cannot write to Google Calendar even if compromised; `reschedule_meeting` archives old event locally and asks Kevin to manually move in Google.

**Status:** Phase 8 plans READY (NOT yet executing). Operator can run `/gsd-execute-phase 8` after:

1. Phase 6 execution complete (loadContext is a Phase 8 dependency)
2. Phase 4 execution complete (email-sender + email.sent event hook is MEM-05 dependency)
3. Operator pre-deploys:
   a. GCP project + OAuth Desktop client; `GCAL_CLIENT_ID` + `GCAL_CLIENT_SECRET` set; run `scripts/bootstrap-gcal-oauth.mjs --account kevin-elzarka` and same for kevin-taleforge
   b. Postiz JWT secret seeded (32-byte random hex) in `kos/postiz-jwt-secret`
   c. Fill in `.planning/brand/BRAND_VOICE.md` with real Kevin voice + flip `human_verification: true`

4. Post-deploy manual steps (documented in 08-03-SUMMARY):
   a. Postiz container first-boot → generate API key → seed `kos/postiz-api-key`
   b. Postiz per-platform OAuth via Postiz UI (Instagram, LinkedIn, TikTok, Reddit, Newsletter)

**Deviations from recommended defaults:** None. All 7 gray-area orchestrator recommendations accepted verbatim. v1 known limitation documented: mutation-proposer vs voice-capture race may produce duplicate artifact on fast voice-capture wins — Approving the mutation cleans up the CC row; v1.1 enhancement adds 3s delay on voice-capture CC insert.

**Plan path:** `.planning/phases/08-outbound-content-calendar/08-CONTEXT.md`.

**Next session:** Operator runs `/gsd-execute-phase 8`. Writes to `services/{content-writer,content-writer-platform,publisher,mutation-proposer,mutation-executor,calendar-reader,document-diff}`, `packages/contracts/src/{content,mutation,calendar,document-version}.ts`, `packages/db/drizzle/0015_phase_8_*.sql`, `packages/context-loader/src/calendar.ts`, `packages/cdk/lib/stacks/integrations-{postiz,publisher,content,calendar,mutations,document-diff}.ts`, `.planning/brand/BRAND_VOICE.md`, 6 Next.js Route Handlers in `apps/dashboard/src/app/api/{content-drafts,pending-mutations}/`, 4 verifier scripts, evidence template.

## Session Continuity Addendum (2026-04-24 — Phase 10)

**Phase 10 planned:** `/gsd-plan-phase 10` (run 2026-04-24, same overnight session as Phase 6/4/7/8 — Kevin asleep, all 7 orchestrator-recommended defaults locked verbatim) produced:

- 10-CONTEXT.md (24 D-XX decisions; 7 gray-area defaults accepted — classify thin-adapter; gmail_classifier full-decom; Discord channel webhook; n8n JSON-export-to-S3; archive-immediately; 14-day cold-inert before power-down; 30-day snapshot retention)
- 10-RESEARCH.md (Notion database-archive semantics, Hetzner snapshot+restore workflow, Discord channel webhook vs gateway, systemd shutdown best practices, AWS Cost Explorer egress limitations, 10+ pitfalls)
- 10-VALIDATION.md (Nyquist-compliant matrix; 26 tasks across 8 plans; 10 operator-run tasks with script companions)
- 8 PLAN files (10-00 scaffold, 10-01 classify-adapter + same-substance, 10-02 morning/evening retirement, 10-03 Brain DB archive, 10-04 Discord Lambda CAP-10, 10-05 n8n decom MIG-02, 10-06 unfrozen VPS scripts retirement, 10-07 Hetzner power-down + rollback + E2E gate)
- 10-ROLLBACK-RUNBOOK.md (<30 min VPS re-spin from Hetzner snapshot + DRY_RUN_EVIDENCE slot)
- 10-07-POWER-DOWN-RUNBOOK.md (Wave 4 operator sequence: snapshot → poweroff → webhook re-test → 14-day probe → T+30 hard-delete)
- 10-07-GATE-evidence-template.md (SC 1-5 + Telegram bonus evidence collection)
- 10-DISCUSSION-LOG.md

**Side-effect closure (Telegram webhook auto-clear / M1):** Phase 10 MIG-02 (n8n kill) + INF-11 (VPS power-off) are the two highest-likelihood remediations per `.planning/debug/telegram-webhook-auto-clear.md`. Plan 10-07 Task 1 includes `scripts/verify-telegram-webhook-persistence.mjs` — a 60-second observation window post-decom with distinct exit codes: exit 0 (PASS — M1 RESOLVED) or exit 2 (ESCALATE — bot token rotation per debug doc Test 3). Either outcome advances the phase.

**Reversibility invariants preserved:** Archive-not-delete applies to all 5 Brain DBs (Status=Archived + title prefix [MIGRERAD-YYYY-MM-DD] + database lock; 90-day Notion trash window; NO page deletion). Hetzner VPS is powered off (not deleted); snapshot `kos-vps-final-YYYYMMDD` labelled `kos-retention=30days`. Rollback runbook rehearsed in dry-run BEFORE real power-down; DRY_RUN_EVIDENCE slot in runbook is a verifier grep target (Plan 10-07 SC 5 blocks until populated).

**Migration number collision guard:** Phase 8 reserves 0015, Phase 10 targets 0016 with bump-to-0017 fallback if any phase lands a later 0016 before Phase 10 executes.

**Wave 3 hard prereq:** Phase 4 Gate 3 PASS (email-triage proven) — gmail_classifier retirement in Plan 10-06 blocks without it.
**Wave 1 hard prereq:** Phase 7 AUTO-01/AUTO-03 deployed — morning_briefing + evening_checkin retirement in Plan 10-02 blocks without them.

**Status:** Phase 10 plans READY (NOT yet executing). Operator can run `/gsd-execute-phase 10` after:

1. Phase 7 execution complete (morning-brief + day-close Lambdas live).
2. Phase 4 execution complete + Gate 3 PASS (email-triage verified).
3. Plan 10-06 operator pre-deploy: `bash scripts/discover-vps-scripts.sh > .planning/phases/10-migration-decommission/vps-service-inventory.json`.
4. Plan 10-07 operator pre-deploy: install `hcloud` CLI + authenticate + rehearse 10-ROLLBACK-RUNBOOK.md in dry-run + paste transcript into DRY_RUN_EVIDENCE section.
5. 14 days of cold-inert VPS observation (Wave 1 + 2 + 3 all landed and stable) before Wave 4 power-down.

**Cost delta:** -$50/mo (Hetzner VPS) + $0.50/mo (30-day snapshot retention) + $0/mo (Discord Lambda at KOS volume) = net **-$49.50/mo** steady-state savings.

**Deviations from recommended defaults:** None. All 7 gray-area orchestrator recommendations accepted verbatim.

**Plan path:** `.planning/phases/10-migration-decommission/10-CONTEXT.md`.

**Next session:** After Phase 7 + Phase 4 execute successfully, operator runs `/gsd-execute-phase 10`. Writes to `services/{vps-classify-migration,discord-brain-dump,n8n-workflow-archiver}`, `packages/contracts/src/migration.ts`, `packages/db/drizzle/0016_phase_10_migration_audit.sql`, `packages/cdk/lib/stacks/integrations-migration.ts`, 11 verifier/operator scripts in `scripts/`, 3 operator runbooks in `.planning/phases/10-migration-decommission/`, 5 test fixtures in `packages/test-fixtures/phase-10/`.

## Session Continuity Addendum (2026-04-24 — Phase 5)

**Phase 5 planned:** `/gsd-plan-phase 5` (run 2026-04-24, same overnight session as Phase 6/4/7/8/10 — Kevin asleep, all 7 orchestrator-recommended defaults locked verbatim) produced:

- 05-CONTEXT.md (25 D-XX decisions; 7 gray-area defaults accepted — esbuild+copy-plugin; unpacked-install; fazer-ai/baileys-api image; Postgres pluggable auth; chrome.alarms+visibility gate; Phase-10 Lambda reuse; defense-in-depth 5-layer read-only + dedicated risk acceptance file)
- 05-RESEARCH.md (MV3 service_worker lifecycle, LinkedIn Voyager shape, Baileys pluggable auth interface, WhatsApp detection heuristics, Discord rate limits, 12 pitfalls including MV3 setInterval death + Voyager cookie rotation + Baileys concurrent-write corruption)
- 05-VALIDATION.md (Nyquist-compliant matrix; 15 tasks across 8 plans; 8 operator-only manual steps with CLI companions)
- 05-WHATSAPP-RISK-ACCEPTANCE.md (Kevin signs before Plan 05-04 executes)
- 8 PLAN files (05-00 scaffold; 05-01 chrome-extension MV3 + highlight + options; 05-02 chrome-webhook Lambda; 05-03 LinkedIn content script + webhook Lambda + 14-day observation; 05-04 Baileys Fargate + 5-layer defense-in-depth + human_verification checkpoint; 05-05 Baileys sidecar Lambda; 05-06 Discord Scheduler + contract doc; 05-07 Gate 5 verifier + E2E verifier + 2 evidence templates)
- 05-DISCUSSION-LOG.md

**Cherry-pick structure:** Plans 05-00/01/02 (CAP-04 Chrome highlight) ship independently of 05-03 (LinkedIn), 05-04/05 (WhatsApp), 05-06 (Discord). Kevin invokes `/gsd-execute-phase 5 --plans 00,01,02` for low-risk Chrome-only subset; defers LinkedIn + WhatsApp + Discord indefinitely without blocking downstream phases.

**Hard Gate 5 lives INSIDE Phase 5:** 4 criteria — 7-day zero-write soak + RDS session persistence + reconnect-without-QR + 4h backoff — all automated or CLI-verifiable via `scripts/verify-gate-5-baileys.mjs` + daily `services/verify-gate-5-baileys` Lambda. Evidence template at `05-07-GATE-5-evidence-template.md`.

**WhatsApp TOS risk disclosure:** `05-WHATSAPP-RISK-ACCEPTANCE.md` is a first-class signed artifact (not inline commentary). Plan 05-04 Task 3 is a `checkpoint:human-verify` that blocks Fargate deploy until Kevin types his full name. Defense-in-depth 5-layer stack (library wrapper + SG egress lock + CloudWatch metric + IAM boundary + soak log assertion) is non-negotiable per D-10.

**Migration number collision guard:** Phase 6 reserves 0012, Phase 4 reserves 0012→0013, Phase 7 reserves 0014, Phase 8 reserves 0015, Phase 10 reserves 0016, Phase 5 targets **0017** with bump-to-next-free guard at execute-time.

**CAP-10 cross-phase contract:** Phase 5 Plan 05-06 ships Scheduler + contract; Phase 10 Plan 10-04 ships Lambda handler. Deploy order resilient either way (SSM parameter `/kos/discord/brain-dump-lambda-arn` bridges). Documented in `05-06-DISCORD-CONTRACT.md`.

**Cost delta:** +$36-38/mo steady-state (Baileys Fargate 1 vCPU × 2GB ARM64 ~$36 + Lambdas + Scheduler ~$1-2). Covered by AWS credits 12+ months.

**Status:** Phase 5 plans READY (NOT yet executing). Operator invocations:

- CAP-04 only (lowest-risk cherry-pick): `/gsd-execute-phase 5 --plans 00,01,02`
- + Discord contract: `--plans 00,01,02,06`
- + LinkedIn defensive (starts 14-day observation): `--plans 00,01,02,03,06`
- Full Phase 5 (including WhatsApp + Gate 5): `--plans 00,01,02,03,04,05,06,07` AFTER Kevin signs `05-WHATSAPP-RISK-ACCEPTANCE.md`

**Deviations from recommended defaults:** None. All 7 gray-area orchestrator recommendations accepted verbatim.

**Plan path:** `.planning/phases/05-messaging-channels/05-CONTEXT.md`.

**Planned Phase:** 06 (granola-semantic-memory) — 10 plans — 2026-04-25T02:00:13.096Z
