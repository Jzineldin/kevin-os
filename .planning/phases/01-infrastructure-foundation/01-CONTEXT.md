# Phase 1: Infrastructure Foundation - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Production-grade AWS substrate + Notion entity schemas + safety rails are in place before any agent logic ships. Phase 1 provisions infra only: CDK stack deploys cleanly, RDS + pgvector ready, S3 + VPC Gateway Endpoint wired, 5 EventBridge buses live, Notion `Entities`/`Projects` DBs created, Kevin Context page seeded, `notion-indexer` Lambda syncing, Azure AI Search index created with binary quantization, AWS Transcribe `sv-SE` custom vocabulary deployed, notification cap + archive-not-delete + cost alarms + VPS freeze active. No agent invocations, no capture channels live yet — those start Phase 2.

Everything Kevin will touch daily (Telegram bot, voice loop, dashboard) lives in later phases. Phase 1 is the foundation those phases build on.

</domain>

<decisions>
## Implementation Decisions

### CDK topology & environments
- **D-01:** Domain-split stacks: `NetworkStack` (VPC + endpoints), `DataStack` (RDS + S3 + Secrets Manager), `EventsStack` (5 EventBridge buses + DLQs + schedulers), `IntegrationsStack` (notion-indexer Lambda, Transcribe custom vocab deploy, Azure AI Search index bootstrap), `SafetyStack` (notification-cap Lambda, cost alarms, VPS-freeze automation). Smaller blast radius per deploy; `DataStack` rarely changes after Phase 1.
- **D-02:** Prod-only — single AWS account, single CDK env. No `dev` environment in Phase 1. Safe iteration via `cdk diff` before deploy. Revisit when a duplicate env would demonstrably prevent a problem.
- **D-03:** Removal policy = `RETAIN` on RDS, S3 buckets, Secrets Manager. `cdk destroy` will not touch stateful resources. Matches archive-not-delete philosophy.
- **D-04:** CDK in TypeScript (matches monorepo language — locked globally in STACK.md).

### VPC egress & networking
- **D-05:** Split Lambda placement. Functions that read/write RDS live inside VPC (private subnets). Functions that only call external APIs (Notion / Telegram / Azure AI Search / Vertex / Bedrock) live outside VPC. **No NAT Gateway in Phase 1** — defer until a Lambda genuinely needs both DB + external in one execution.
- **D-06:** VPC Endpoints provisioned in Phase 1: **S3 Gateway Endpoint only** (INF-03 requirement). Secrets Manager / Bedrock / EventBridge interface endpoints deferred until measured cold-start or cost data justifies them.
- **D-07:** RDS PostgreSQL 16 single-AZ, `db.t4g.medium`, eu-north-1, 7-day automated backup retention. Multi-AZ and reserved pricing revisit post–Gate 4 (daily-use established).

### notion-indexer sync
- **D-08:** EventBridge Scheduler fires the indexer every 5 min per watched DB. Query uses `filter: last_edited_time >= last_cursor − 2 min` (2-min overlap absorbs Notion clock skew / late writes). Cursor stored in RDS `notion_indexer_cursor` table per DB.
- **D-09:** Idempotency via composite key `(page_id, last_edited_time)`. Upsert skips write if existing row's `last_edited_time >= incoming`. Status changes flow through; hard-deletes are rejected (archive-not-delete).
- **D-10:** Initial backfill via a one-shot `notion-indexer-backfill` Lambda triggered manually (CLI). Walks every page in the watched DBs, upserts all. Phase 1 done criterion: second backfill run yields zero new rows. Steady-state poller takes over from there.
- **D-11:** Watched DBs in Phase 1: **Entities, Projects, Kevin Context, Command Center**. Transkripten is added in Phase 6; Brain DBs excluded (Phase 10 archive).

### Safety rails, notification cap, freeze
- **D-12:** 3-per-day Telegram cap enforced via **DynamoDB single-key table with TTL**. Key = `telegram-cap#YYYY-MM-DD` where date is Stockholm-local. ADD +1 on each send, reject if > 3. TTL auto-purges old days. Independent of RDS uptime — safety rail holds even during DB maintenance.
- **D-13:** The `push-telegram` Lambda computes the Stockholm date/hour on every send via `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})`. Same function enforces quiet hours (20:00–08:00 Stockholm = hard block; suppressed items queue to Notion Inbox DB for morning surfacing). Quiet hours ship in Phase 1 (not deferred to Phase 7) — the risk of a 3am ping isn't worth waiting.
- **D-14:** VPS freeze = **soft redirect**. `classify_and_save`, `morning_briefing`, `evening_checkin` scripts patched to write into a new Notion `Legacy Inbox` DB instead of Command Center / Kontakter / Daily Brief Log. VPS + n8n keep running. No destructive action. Full decommission lives in Phase 10 after KOS runs the full daily rhythm.
- **D-15:** Cost alarms route via **SNS → email** to `kevin@tale-forge.app`. Two thresholds: $50 warn / $100 critical. Email is the canonical channel for infra alarms — never Telegram (would consume cap + get suppressed in quiet hours). Dashboard banner is deferred to Phase 3.

### Claude's Discretion
- CDK app directory layout (`cdk/lib/*.ts` vs `cdk/stacks/*.ts`), construct extraction patterns, internal Lambda bundling approach (esbuild vs Rollup).
- Exact VPC CIDR blocks, subnet sizing, AZ selection (eu-north-1a + eu-north-1b for RDS subnet group).
- DLQ retention period per bus, dead-letter event format, schema registry strategy.
- Drizzle migration file naming and directory structure; initial schema shape beyond the mandatory tables (`entity_index`, `project_index`, `agent_runs`, `notion_indexer_cursor`, `mention_events`, `event_log`, plus whatever's needed to back the safety rails).
- Exact Azure AI Search index field schema (vector dimensions, analyzer choice) — as long as binary quantization is configured at creation time.
- Custom-vocabulary initial term list content — Kevin will provide names/terms async or first backfill exports them from Kontakter; not blocking on this decision.
- CloudWatch log retention per log group (default 30 days per STACK.md).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project definition & scope
- `.planning/PROJECT.md` — KOS vision, constraints, locked key decisions, active threads Kevin is running against.
- `.planning/REQUIREMENTS.md` — all 54 v1 requirements; Phase 1 owns INF-01, INF-02, INF-03, INF-04, INF-05, INF-06 (cluster only), INF-07, INF-08 (vocab deploy), INF-09, ENT-01, ENT-02, MEM-01, MEM-02, MIG-04 (freeze).
- `.planning/ROADMAP.md` §Phase 1 — goal statement, 6 success criteria, Gate 1 crossover checklist.
- `.planning/STATE.md` — 14 locked decisions that apply across all phases; 6 open questions (Bedrock region, Transcribe region, Agent SDK cache parity, Notion EU residency, EmailEngine license, Vercel stream limits).

### Research & stack rationale
- `.planning/research/STACK.md` — chosen libraries + versions + "what NOT to use" list; Phase 1 implementations must align.
- `.planning/research/ARCHITECTURE.md` — system topology, event contracts, Fargate vs Lambda split rationale.
- `.planning/research/PITFALLS.md` — known failure modes to design around; Phase 1 pitfalls around Aurora HNSW, EmailEngine single-instance, Baileys persistence, Postgres IAM auth.
- `.planning/research/SUMMARY.md` — synthesis of research findings.
- `.planning/research/FEATURES.md` — feature inventory.

### Gate definitions
- `.planning/ROADMAP.md` §"Hard Gates" — Gate 1 (Entity Foundation Ready) is the Phase 1 → Phase 2 checkpoint. Plan must verify all 9 Gate 1 criteria are testable at execution time.

### Project conventions
- `CLAUDE.md` §"Recommended Stack" — canonical version table (Node 22.x, Next 15, Drizzle 0.30+, pgvector 0.8.0, Azure SDK 11.6.0, etc.).
- `CLAUDE.md` §"What NOT to Use" — explicit exclusion list; researcher/planner must not propose LangGraph, Aurora Serverless v2, n8n, Prisma, etc.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project. No prior TypeScript, CDK, or Lambda code in the repo. Repo currently contains `.planning/` artifacts, `CLAUDE.md`, and two standalone HTML mockups (`KOS-overview.html`, `KOS-ui.html`).

### Established Patterns
- `.planning/` documentation pattern established via GSD workflow — every phase decision lives in structured markdown here.
- Swedish/English code-switching in user-facing strings and data (per PROJECT.md language constraint).
- Single-user single-account AWS usage model — no multi-tenant abstractions need to be planned around.

### Integration Points
- Notion workspace (existing) — Phase 1 creates two new DBs (`Entities`, `Projects`) and seeds a new `Legacy Inbox` DB for the VPS freeze redirect. Existing workspace schema elsewhere is untouched.
- Existing Hetzner VPS at 98.91.6.66 runs `classify_and_save`, `morning_briefing`, `evening_checkin`, `gmail_classifier`, `brain-dump-listener`, `sync_aggregated`, n8n on port 5678. Phase 1 patches the three write-path scripts to target `Legacy Inbox`; leaves the rest running.
- AWS account (existing, has Bedrock IAM user wired). Phase 1 adds CDK bootstrap, VPC, all other infra into this account.
- Azure subscription (existing, $5k credits). Phase 1 creates one AI Search service in West Europe.

</code_context>

<specifics>
## Specific Ideas

- Gate 1 is the binding contract — the plan's verification pass must make all 9 Gate 1 criteria individually testable (not "looks deployed" hand-waving). CDK synth + CLI assertions against real AWS/Azure/Notion state.
- The `kos.*` EventBridge bus names are load-bearing across 10 phases — do not rename.
- Kevin's workflow philosophy from PROJECT.md: "Zero categorization friction on input. Calm-by-default on output." Even the cost alarm email subject line should respect this — one short line, no panic formatting.
- VPS freeze message markers `[MIGRERAD]` / `[SKIPPAT-DUP]` convention from PROJECT.md constraints applies to any script edit during freeze.

</specifics>

<deferred>
## Deferred Ideas

- **Custom vocabulary content sourcing** — *which* names and terms go into the initial `sv-SE` vocab file. Blocking decision lives with Kevin; not blocking Phase 1 CDK/infra work. Plan should expose a `deploy-transcribe-vocab` task that reads from a configurable source file so content can land late.
- **Observability baseline scope** — Langfuse + Sentry + X-Ray wiring in Phase 1 vs deferring to first agent phase. Recommendation: ship CloudWatch (30-day) + cost alarms in Phase 1, defer Langfuse/Sentry to Phase 2 alongside the first agent invocations. Final call during planning.
- **Secret bootstrapping** — which secrets get real values vs placeholders in Phase 1. Plan should list every Secrets Manager entry and flag which need Kevin-provided values before Gate 1.
- **Bedrock region decision (STATE.md open question #1)** — if Sonnet 4.6 / Haiku 4.5 are not available in eu-north-1, plan needs to document the us-east-1 cross-region LLM traffic and GDPR justification.
- **Vercel stream limits (STATE.md open question #6)** — Hobby vs Pro. Belongs to Phase 3 (Dashboard MVP); just flagging so Phase 1 doesn't lock a Vercel project into the wrong tier.
- **HA NAT / Multi-AZ RDS / VPC interface endpoints** — expansion options for later phases once real load exists.
- **Notion Automations webhooks as sync backstop** — pure polling is sufficient for Phase 1; webhooks can be added in a later phase if 5-min latency becomes a user-visible problem.

</deferred>

---

*Phase: 01-infrastructure-foundation*
*Context gathered: 2026-04-22*
