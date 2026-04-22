# Phase 1: Infrastructure Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** 01-infrastructure-foundation
**Areas discussed:** CDK topology & envs, VPC egress strategy, notion-indexer sync, Safety rails + freeze

---

## CDK topology & envs

### Q1: How should the CDK code be structured?

| Option | Description | Selected |
|--------|-------------|----------|
| Domain-split (Recommended) | Separate stacks: Network / Data / Events / Integrations / Safety. Smaller blast radius. | ✓ |
| Monolithic single stack | One KOSStack.ts. Simpler but bad changes cascade. | |
| App-level split (per agent) | Stacks per feature area. Over-engineered for Phase 1. | |

### Q2: Which environments should Phase 1 provision?

| Option | Description | Selected |
|--------|-------------|----------|
| Prod-only (Recommended) | Single AWS account. Saves ~$70/mo. Test via `cdk diff`. | ✓ |
| dev + prod side-by-side | ~$100-140/mo extra for idle dev. | |
| Ephemeral PR envs | Overkill for single-user. | |

### Q3: Removal policy for stateful resources?

| Option | Description | Selected |
|--------|-------------|----------|
| RETAIN (Recommended) | `cdk destroy` will not nuke RDS/S3/Secrets. Matches archive-not-delete. | ✓ |
| SNAPSHOT on RDS, RETAIN on rest | Middle ground. | |
| DESTROY | Ruled out by archive-not-delete principle. | |

**Notes:** No pushback on recommendations — Kevin moved through quickly, indicating alignment with the published design decisions in STATE.md.

---

## VPC egress strategy

### Q1 (first attempt): How should Lambdas reach the outside world?

| Option | Description | Selected |
|--------|-------------|----------|
| Single NAT Gateway (Recommended) | ~$32/mo. Simple mental model. | |
| VPC endpoints only, no NAT | Blocks Notion/Telegram/Azure calls. Ruled out. | |
| Split: in-VPC for RDS, out-VPC for external | Cheapest + fastest cold-starts. | |
| HA NAT (one per AZ) | ~$64/mo. Overkill. | |

**User's initial response:** "I dont get this queston tbh, what?" — Claude re-explained VPC egress in plain language before re-asking.

### Q1 (re-asked): How should Lambdas reach the outside world? (re-explained)

| Option | Description | Selected |
|--------|-------------|----------|
| Split: VPC only when needed (Recommended) | Lambdas that hit RDS in VPC; external-only Lambdas outside VPC. No NAT. | ✓ |
| NAT Gateway, all Lambdas in VPC | Simpler but ~$32/mo. | |
| Decide later, stub it in Phase 1 | Defer to Phase 2. | |

### Q2: Which VPC Endpoints in Phase 1? (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| S3 Gateway Endpoint (required) | Free. Required by INF-03. | ✓ |
| Secrets Manager Interface Endpoint | ~$7/mo per AZ. | |
| Bedrock Runtime Interface Endpoint | ~$7/mo per AZ. | |
| EventBridge Interface Endpoint | ~$7/mo per AZ. | |

### Q3: RDS availability configuration?

| Option | Description | Selected |
|--------|-------------|----------|
| Single-AZ (Recommended) | ~$52/mo on-demand. Matches predictable light load. | ✓ |
| Multi-AZ | 2× cost. Overkill pre-daily-use. | |
| Single-AZ + read replica | No read-scaling problem to solve. | |

**Notes:** The re-explanation on egress was warranted — the default option framing assumed AWS networking fluency. Logged so future phase discussions offer plain-language translations when a question lands as jargon.

---

## notion-indexer sync

### Q1: Sync model?

| Option | Description | Selected |
|--------|-------------|----------|
| EventBridge Scheduler + last_edited_time (Recommended) | 5-min poll per DB, 2-min cursor overlap. | ✓ |
| Notion Automations webhooks | Near-realtime but brittle. | |
| Hybrid webhook + poll backstop | More code, marginal latency win. | |

### Q2: Idempotency strategy?

| Option | Description | Selected |
|--------|-------------|----------|
| (page_id, last_edited_time) composite (Recommended) | Skip if existing row is newer. Archive-not-delete honored. | ✓ |
| ULID capture_id per poll cycle | Adds audit table. Over-engineered. | |
| Hash-based (SHA of body) | Avoids no-op writes but costlier. | |

### Q3: Initial backfill approach?

| Option | Description | Selected |
|--------|-------------|----------|
| One-shot backfill Lambda, then hand off (Recommended) | Manual CLI trigger; poller takes over. | ✓ |
| Poller handles on first run | Risk of Lambda timeout on large tables. | |
| Manual export + SQL COPY | Not idempotent; not steady-state path. | |

### Q4: Which Notion DBs in Phase 1? (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| Entities (required) | ENT-01 locked. | ✓ |
| Projects (required) | ENT-02 locked. | ✓ |
| Kevin Context page (required) | MEM-02 locked. | ✓ |
| Command Center (recommended) | 167-row task substrate. | ✓ |

---

## Safety rails + freeze

### Q1: Cap counter store?

| Option | Description | Selected |
|--------|-------------|----------|
| DynamoDB single-key with TTL (Recommended) | Independent of RDS uptime. ~$0. | ✓ |
| Postgres row per day | Couples safety rail to RDS. | |
| Lambda Powertools Idempotency | Pre-built but adds dependency. | |

### Q2: Stockholm day + quiet hours enforcement?

| Option | Description | Selected |
|--------|-------------|----------|
| push-telegram Lambda computes tz (Recommended) | Single source of truth via toLocaleString('sv-SE'). | ✓ |
| Scheduler tz + UTC counter | Edge cases around UTC midnight. | |
| Defer quiet hours to Phase 7 | Leaves 3am ping risk. | |

### Q3: VPS freeze approach?

| Option | Description | Selected |
|--------|-------------|----------|
| Soft: redirect to Legacy Inbox (Recommended) | Scripts write to new Notion DB. Zero data loss risk. | ✓ |
| Hard: disable all VPS cron/systemd | Risky to do in Phase 1 pre-Phase-2. | |
| Hybrid: kill classifiers, keep briefings | Still some dual-surface risk. | |

### Q4: Cost alarm routing?

| Option | Description | Selected |
|--------|-------------|----------|
| SNS → email (Recommended) | Canonical for infra; doesn't consume Telegram cap. | ✓ |
| SNS → Telegram | Would consume cap and get suppressed in quiet hours. | |
| Email + dashboard banner | Dashboard deferred to Phase 3. | |

---

## Claude's Discretion

Captured in CONTEXT.md `<decisions>` section. Summary: CDK app layout, VPC CIDR details, DLQ retention values, Drizzle migration file layout, Azure AI Search field-level schema, CloudWatch log retention per group, custom-vocab term list content, and observability scope are all Claude-decidable during planning.

## Deferred Ideas

- Custom vocabulary content sourcing (Kevin provides or derived from Kontakter export)
- Observability baseline scope (Phase 1 vs Phase 2 for Langfuse/Sentry)
- Secret bootstrapping placeholder/real-value map
- Bedrock region decision (STATE.md open question #1)
- Vercel stream limits (belongs to Phase 3)
- HA NAT, Multi-AZ RDS, additional VPC interface endpoints
- Notion Automations webhooks as sync backstop
