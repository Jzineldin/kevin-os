---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-21T23:44:41.290Z"
progress:
  total_phases: 10
  completed_phases: 0
  total_plans: 9
  completed_plans: 0
  percent: 0
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
**Status:** Executing Phase 01
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
