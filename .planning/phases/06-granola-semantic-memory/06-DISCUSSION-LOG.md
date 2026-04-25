# Phase 6 — Discussion Log

**Created:** 2026-04-24
**Mode:** standard (no live discussion; defaults locked per orchestrator brief)
**Operator:** Claude (planner) operating under explicit instructions from the orchestrator brief; Kevin asleep at planning time.

---

## Pre-planning context

The orchestrator brief explicitly stated:

> Treat these as locked-in defaults given Kevin is asleep; pick the recommended default and document rationale.

Four gray-area decisions were named with recommended defaults. Planner accepted all four recommended defaults; rationale is recorded in 06-CONTEXT.md.

---

## Decision audit

| Gray area | Recommended default | Decision taken | Justification |
|-----------|---------------------|----------------|---------------|
| Azure Search indexer shape | One Lambda per content type (entities/projects/transcripts/daily-brief) | **ACCEPTED** (D-09) | Cleaner separation; per-type scheduler + DLQ + Sentry breadcrumbs; per-type backoff if Azure RU/min throttle; smaller blast radius on bugs. Trade-off accepted: 4 Lambdas instead of 1 means slightly more invocation count — well within EventBridge free tier (1M events/mo). |
| Dossier cache substrate | Postgres `entity_dossiers_cached` table | **ACCEPTED** (D-17) | Phase 1 RDS Proxy already handles this access pattern; ElastiCache Serverless adds a new ops surface for $10/mo at single-user scale; Postgres-side trigger invalidation is simpler than ElastiCache TTL games. Revisit if cache hit rate <50% after 1 production week, or if RDS CPU from cache reads >5% of total. |
| AGT-06 extraction output format | Bedrock `tool_use` (structured tools) | **ACCEPTED** (D-05) | Matches the AnthropicBedrock direct-SDK pattern from Phase 2 (used by entity-resolver disambig); cleaner than XML/markdown parsing; tool_use is first-class on Bedrock for Sonnet 4.6 + Haiku 4.5. Trade-off accepted: tool_use prompt overhead ~500 tokens per call — well under the Sonnet 200k context. |
| Gemini invocation trigger | New EventBridge detail-type `context.full_dossier_requested` | **ACCEPTED** (D-20) | Easier cost monitoring (one CloudWatch metric per detail-type); cleaner separation between fast path (mention.detected) and expensive Gemini path; distinct DLQ + retry policy for the expensive call. Pattern matches the rest of the KOS event taxonomy. |

No deviations from recommended defaults.

---

## Architectural decisions inherited (NOT relitigated)

These are project-level locks the planner must honor; reproduced here for cross-reference:

- **Locked Decision #3 (REVISED 2026-04-23)**: Direct AnthropicBedrock SDK, NOT Claude Agent SDK. Phase 6 inherits this without exception. AGT-04 was redesigned as an explicit `loadContext()` helper because of this revision (the original Agent-SDK pre-call hook spec is unworkable on the direct SDK).
- **Locked Decision #6**: Azure AI Search Basic with binary quantization at index creation — not retrofittable; we re-use the index Phase 1 created (recreated to 1024 dims in Phase 2 D-06).
- **Locked Decision #11**: Hard cap of 3 Telegram messages/day — Phase 6 emits no Telegram pushes (action items land silently in Command Center; Kevin sees them in Phase 7's morning brief).
- **Locked Decision #12**: Archive-never-delete — Phase 6's mention_events INSERT trigger DELETEs cache rows but the cache is by definition derived/transient; entity rows never deleted.
- **Locked Decision #13**: `owner_id` on every RDS table — Phase 6 migration 0012's new tables follow this.

---

## Sized-down options considered + rejected

| Idea | Considered for | Rejected because |
|------|----------------|------------------|
| Skip Vertex Gemini in Phase 6, defer INF-10 to Phase 9 | Reducing surface | INF-10 is in Phase 6's REQUIREMENTS; deferring would leave the requirement orphaned. Building dossier-loader as v1 operator-only trigger is small scope (one Lambda + one EB rule) and unblocks future auto-trigger work. |
| Build a single unified azure-search-indexer Lambda | Reducing Lambda count | Per the recommended default; rejected for the reasons in D-09 above. |
| Skip the materialized view and just query mention_events | Reducing migration surface | At 100k mention_events the dashboard read would breach the 50ms SLO. MV is a one-time migration cost for ongoing perf benefit. |
| Make AGT-04 an HTTP service Lambda each agent calls | Reducing library coupling | Adds 100-500ms cold-start + network round-trip per call. Library import is zero transport latency; pg.Pool reuse across calls within a Lambda is automatic. Phase 4 + Phase 7 + Phase 8 all benefit from the same library. |
| Build a separate cache for Kevin Context block | Reducing context-loader complexity | Kevin Context already paid for via Bedrock prompt caching cache_control:ephemeral. Loading from RDS each call is cheap (single SQL query against the kevin_context table). No additional cache layer needed. |

---

## Open questions for Phase 7 / Phase 4 hand-off

1. **Phase 4 (email-triage)**: when it lands, it should import `@kos/context-loader` and call `loadContext({ entityIds: <resolved-from-email-headers>, agentName: 'email-triage', ... })`. Phase 6 publishes the library shape; Phase 4 plans should import it without modification.
2. **Phase 7 (morning brief)**: AGT-04 is a quality multiplier for the brief writer. Brief generation should call `loadContext({ entityIds: <top-5-recent>, agentName: 'morning-brief', rawText: '<top priorities>', ... })` to pull in fresh dossier context.
3. **Auto-trigger Gemini full-dossier**: when an entity hasn't had a Gemini-cached dossier in N days. Considered for Phase 6 v1; deferred to a future plan to keep the Gemini cost surface bounded by operator-explicit invocations.
4. **Action-item urgent/not-urgent classification**: Phase 6 writes all extracted action items with default `Att göra` status. Phase 7 (lifecycle automation) is where urgency triage belongs.

---

## Locked-in defaults (cross-reference for executor agents)

Every D-XX decision in 06-CONTEXT.md was set BY THE PLANNER on Kevin's behalf, with the explicit understanding that:
- Kevin can override any decision by amending CONTEXT.md before Plan 06-NN execution begins.
- The planner picked the recommended default from the orchestrator brief in all four gray areas (D-05, D-09, D-17, D-20).
- All other D-XX decisions are derived from existing project conventions (CLAUDE.md, PROJECT.md, prior phase summaries) and are minimum-surprise choices.

---

*Discussion log: 2026-04-24*
