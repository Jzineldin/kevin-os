# Phase 1: Infrastructure Foundation - Research

**Researched:** 2026-04-22
**Domain:** AWS CDK IaC + RDS PostgreSQL + Azure AI Search + Notion integration + safety rails
**Confidence:** HIGH on CDK/AWS mechanics and Drizzle pgvector; MEDIUM on Azure Search binary-quantization payload details and AWS Transcribe Swedish feature set

## Summary

Phase 1 is pure infrastructure and safety plumbing — no agent code, no capture surface, no user interaction. The research confirms every locked decision (D-01..D-15) in CONTEXT.md is implementable with first-party AWS / Azure / Notion APIs, with one non-blocking surprise worth flagging early: **AWS Transcribe SoundsLike/IPA columns appear to be deprecated for all languages including Swedish**, reducing custom vocabulary to phrase-only table format. Gate 1's 9 criteria are all individually testable via `cdk synth`/`cdk diff`, AWS CLI assertions, Notion API queries, and a small number of integration shell scripts; no "looks deployed" hand-waving is required.

Three hard gotchas the planner must design around: (1) SNS email subscriptions require Kevin to click a confirmation link after `cdk deploy` — CDK cannot auto-confirm, so `/cdk-deploy` is a two-step ritual; (2) CloudWatch billing metrics only exist in `us-east-1`, so cost alarms must use AWS Budgets (multi-region) rather than `Metric` alarms — AWS Budgets is also the current AWS-recommended approach; (3) binary quantization on Azure AI Search is a one-shot configuration at index creation time (confirmed via Microsoft docs) — recreating the index later requires full re-indexing, so get it right first time.

**Primary recommendation:** Use `aws-cdk-lib/aws-lambda-nodejs` (NodejsFunction) with esbuild bundling for all Lambdas, Drizzle 0.31+ built-in `vector()` column type (NOT custom type) for pgvector columns, Azure AI Search REST API `2025-09-01` with explicit `vectorSearch.compressions[]` block at index-create time, and AWS Budgets (not CloudWatch billing alarms) for cost thresholds. Ship the VPS freeze as a single patched file per script, not a fork.

## User Constraints (from CONTEXT.md)

### Locked Decisions

**CDK topology & environments**
- **D-01:** Domain-split stacks: `NetworkStack` (VPC + endpoints), `DataStack` (RDS + S3 + Secrets Manager), `EventsStack` (5 EventBridge buses + DLQs + schedulers), `IntegrationsStack` (notion-indexer Lambda, Transcribe custom vocab deploy, Azure AI Search index bootstrap), `SafetyStack` (notification-cap Lambda, cost alarms, VPS-freeze automation).
- **D-02:** Prod-only — single AWS account, single CDK env. No `dev` environment. Safe iteration via `cdk diff` before deploy.
- **D-03:** Removal policy = `RETAIN` on RDS, S3 buckets, Secrets Manager. `cdk destroy` will not touch stateful resources.
- **D-04:** CDK in TypeScript (matches monorepo language).

**VPC egress & networking**
- **D-05:** Split Lambda placement. Functions that read/write RDS live inside VPC (private subnets). Functions that only call external APIs live outside VPC. **No NAT Gateway in Phase 1.**
- **D-06:** VPC Endpoints provisioned in Phase 1: **S3 Gateway Endpoint only**. Interface endpoints deferred.
- **D-07:** RDS PostgreSQL 16 single-AZ, `db.t4g.medium`, eu-north-1, 7-day automated backup retention.

**notion-indexer sync**
- **D-08:** EventBridge Scheduler fires indexer every 5 min per watched DB. Filter `last_edited_time >= last_cursor − 2 min`. Cursor stored in RDS `notion_indexer_cursor` table per DB.
- **D-09:** Idempotency via composite key `(page_id, last_edited_time)`. Upsert skips write if existing `last_edited_time >= incoming`. Status changes flow; hard-deletes rejected.
- **D-10:** Initial backfill via one-shot `notion-indexer-backfill` Lambda triggered manually (CLI). Done-criterion: second run yields zero new rows.
- **D-11:** Watched DBs: **Entities, Projects, Kevin Context, Command Center**. Transkripten added Phase 6.

**Safety rails, notification cap, freeze**
- **D-12:** 3-per-day Telegram cap via **DynamoDB single-key table with TTL**. Key = `telegram-cap#YYYY-MM-DD` (Stockholm-local). ADD +1 on each send, reject if > 3.
- **D-13:** Stockholm date/hour computed via `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})`. Quiet hours 20:00–08:00 Stockholm = hard block; suppressed items queue to Notion Inbox. Quiet hours ship in Phase 1.
- **D-14:** VPS freeze = **soft redirect**. `classify_and_save`, `morning_briefing`, `evening_checkin` patched to write into new Notion `Legacy Inbox` DB. VPS + n8n keep running.
- **D-15:** Cost alarms route via **SNS → email** to `kevin@tale-forge.app`. $50 warn / $100 critical. Email-only. Dashboard banner deferred.

### Claude's Discretion

- CDK app directory layout (`cdk/lib/*.ts` vs `cdk/stacks/*.ts`), construct extraction patterns, internal Lambda bundling approach (esbuild vs Rollup).
- Exact VPC CIDR blocks, subnet sizing, AZ selection (eu-north-1a + eu-north-1b).
- DLQ retention period per bus, dead-letter event format, schema registry strategy.
- Drizzle migration file naming and directory structure; initial schema shape beyond mandatory tables.
- Exact Azure AI Search index field schema — as long as binary quantization is configured at creation time.
- Custom-vocabulary initial term list content.
- CloudWatch log retention per log group (default 30 days).

### Deferred Ideas (OUT OF SCOPE)

- Custom vocabulary content sourcing (names/terms) — blocking decision lives with Kevin; not blocking Phase 1 infra.
- Observability baseline scope (Langfuse, Sentry, X-Ray) — defer to Phase 2.
- Secret bootstrapping placeholder strategy — list entries, flag which need real values.
- Bedrock region decision — not blocking Phase 1 (no agent calls).
- Vercel stream limits — Phase 3 concern.
- HA NAT / Multi-AZ RDS / VPC interface endpoints — later phases.
- Notion Automations webhooks as sync backstop — polling sufficient for Phase 1.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INF-01 | AWS CDK stack, single AWS account primary cloud | §Standard Stack (CDK + esbuild); §Architecture Patterns (5-stack split) |
| INF-02 | RDS PostgreSQL 16 db.t4g.medium eu-north-1, pgvector 0.8.0, Drizzle migrations | §RDS + pgvector 0.8.0; §Drizzle pgvector types |
| INF-03 | S3 bucket eu-north-1 with VPC Gateway Endpoint before any Lambda writes | §S3 Gateway Endpoint topology |
| INF-04 | 5 EventBridge custom buses (`kos.capture/triage/agent/output/system`) | §EventBridge contracts; §DLQ strategy |
| INF-05 | Lambda Node.js 22.x for event-driven; Step Functions reserved for >15min | §Lambda placement matrix |
| INF-06 | ECS Fargate ARM64 cluster — one service per task | §Fargate cluster scaffold (Phase 1 scope: cluster only) |
| INF-07 | Secrets Manager for API keys, OAuth tokens, Bearer tokens | §Secret bootstrapping |
| INF-08 | Transcribe sv-SE + custom vocabulary deployed | §AWS Transcribe custom vocabulary deployment |
| INF-09 | Azure AI Search Basic West Europe, binary quantization at creation, hybrid | §Azure AI Search binary quantization |
| ENT-01 | Notion `Entities` DB with 13 fields | §Notion DB bootstrap; §Notion indexer schema |
| ENT-02 | Notion `Projects` DB with full schema | §Notion DB bootstrap |
| MEM-01 | Notion = SoT; `notion-write-confirmed` event triggers Postgres upsert | §Notion indexer mechanics |
| MEM-02 | Kevin Context page seeded, prompt-cache-ready | §Notion DB bootstrap (seed content) |
| MIG-04 (freeze) | VPS soft redirect to `Legacy Inbox`, markers `[MIGRERAD]`/`[SKIPPAT-DUP]` | §VPS freeze mechanics |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `aws-cdk-lib` | 2.248.x (latest stable) | CDK v2 monolithic package | Current LTS-style; all constructs in one package; matches CLAUDE.md "TypeScript monorepo" [CITED: docs.aws.amazon.com/cdk/api/v2] |
| `aws-cdk-lib/aws-lambda-nodejs` (NodejsFunction) | bundled with aws-cdk-lib 2.248 | Lambda TypeScript bundler with esbuild | Official AWS recommendation for TS Lambdas; tree-shakes + minifies; externalizes `@aws-sdk/*` automatically [CITED: docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html] |
| `esbuild` | 0.23.x | Local bundler invoked by NodejsFunction | If installed locally, CDK uses it directly; otherwise falls back to Docker. Local install recommended (Windows: Docker volume perf is slow) [CITED: AWS CDK docs] |
| `@aws-sdk/client-*` v3 | 3.668+ | AWS SDK v3 modular clients | In Lambda runtime already (Node.js 22.x); mark as external in esbuild to shrink bundle [CITED: docs.aws.amazon.com] |
| `drizzle-orm` | 0.31.0+ (pin 0.31+, NOT 0.30) | Postgres ORM | **0.31+ added built-in `vector()` column type** — no custom type needed [VERIFIED: orm.drizzle.team/docs/guides/vector-similarity-search] |
| `drizzle-kit` | 0.24.x | Schema migrations | Use `drizzle-kit generate` + explicit `migrate` (NOT `push`) for auditability [CITED: orm.drizzle.team] |
| `pg` | 8.12+ | Postgres driver | Used by Drizzle; connection pooling handled outside Lambda (one conn per invocation acceptable at KOS volume) |
| `@notionhq/client` | 2.3.x | Notion API client | Official; stable on API version `2022-06-28` [CITED: developers.notion.com] |
| `@azure/search-documents` | 12.1.x (latest; SDK renumbered past v11.6.0 — verify `npm view`) | Azure AI Search REST SDK | Supports REST API `2025-09-01` with binary quantization [CITED: learn.microsoft.com/en-us/azure/search] |
| `zod` | 3.23+ | Schema validation | Validate webhook payloads, EventBridge event detail shapes |
| `ulid` | 2.3+ | capture_id / event correlation IDs | Sortable, short, safe for DynamoDB keys |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@aws-sdk/client-eventbridge` | v3 latest | PutEvents from Lambdas | All publishers |
| `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` | v3 latest | Notification cap table ops | `DynamoDBDocumentClient.update` with ADD expression |
| `@aws-sdk/client-sns` | v3 latest | Billing alarm publishing (Budgets → SNS → email) | SafetyStack wiring |
| `@aws-sdk/client-transcribe` | v3 latest | `CreateVocabulary` at deploy-time custom resource | Transcribe vocab deploy Lambda |
| `dotenv` | 16.x | Local env loading | Drizzle config; local cdk synth |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `NodejsFunction` (esbuild) | `@aws-cdk/aws-lambda-python-alpha` | Would force Python runtime; rejected — TypeScript monorepo |
| Drizzle 0.31 built-in `vector()` | Custom `customType<>()` wrapper | Built-in is newer; use it unless dims are dynamic — they aren't |
| AWS CloudWatch billing alarms | AWS Budgets | **AWS Budgets is the current AWS-recommended approach**; CloudWatch billing metrics only exist in us-east-1 (forces cross-region complexity for a eu-north-1 stack); Budgets supports email/SNS/Lambda actions natively [CITED: docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html] |
| Drizzle `push` for schema deploy | Drizzle `migrate` (committed SQL) | `push` is convenient in dev but skips migration audit trail; phase uses `migrate` |
| Bearer token in env var | Bearer token in Secrets Manager | Secrets Manager is already required (INF-07); one fewer config surface |

**Installation (root of monorepo):**

```bash
# CDK app
npm install aws-cdk-lib constructs esbuild
npm install -D aws-cdk @types/node typescript ts-node

# Lambda runtime deps (root package for shared)
npm install @aws-sdk/client-eventbridge @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb \
  @aws-sdk/client-sns @aws-sdk/client-transcribe @aws-sdk/client-s3 \
  @aws-sdk/client-secrets-manager \
  @notionhq/client @azure/search-documents drizzle-orm pg zod ulid

# Dev
npm install -D drizzle-kit @types/pg
```

**Version verification:** Before the plan locks versions, run:

```bash
npm view aws-cdk-lib version           # expect ≥ 2.248
npm view drizzle-orm version           # expect ≥ 0.31.0 (built-in vector type)
npm view @azure/search-documents version  # verify SDK supports api-version 2025-09-01
npm view @notionhq/client version      # expect ≥ 2.3 on API 2022-06-28
```

All versions above are dated to April 2026 `[ASSUMED]` from training + web search — registry verification required in Wave 0.

## Architecture Patterns

### Recommended Project Structure

```
kos/                                           # monorepo root
├── cdk/                                       # Phase 1 primary artifact
│   ├── bin/
│   │   └── kos.ts                             # App entry, wires 5 stacks
│   ├── lib/
│   │   ├── stacks/
│   │   │   ├── network-stack.ts               # VPC, subnets, S3 Gateway Endpoint
│   │   │   ├── data-stack.ts                  # RDS, S3 buckets, Secrets Manager
│   │   │   ├── events-stack.ts                # 5 EventBridge buses + DLQs + Schedulers
│   │   │   ├── integrations-stack.ts          # notion-indexer, vocab deploy, Azure bootstrap
│   │   │   └── safety-stack.ts                # notification-cap, Budgets alarms, VPS-freeze
│   │   ├── constructs/
│   │   │   ├── kos-lambda.ts                  # NodejsFunction wrapper (defaults, bundling)
│   │   │   ├── kos-bus.ts                     # EventBridge bus + DLQ helper
│   │   │   └── kos-rds.ts                     # RDS + pgvector extension bootstrap
│   │   └── config/
│   │       └── env.ts                         # Typed config (Stockholm TZ constant, etc.)
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── packages/
│   ├── db/                                    # Drizzle schema + migrations (shared with services/)
│   │   ├── schema.ts                          # entity_index, project_index, notion_indexer_cursor, etc.
│   │   ├── migrations/
│   │   │   └── 0001_initial.sql
│   │   ├── drizzle.config.ts
│   │   └── index.ts
│   └── contracts/                             # Typed EventBridge event shapes (Zod)
│       └── events.ts
├── services/
│   ├── notion-indexer/                        # Steady-state 5-min poller
│   │   ├── src/handler.ts
│   │   └── package.json
│   ├── notion-indexer-backfill/               # One-shot manual trigger
│   │   └── src/handler.ts
│   ├── transcribe-vocab-deploy/               # Custom resource Lambda
│   │   └── src/handler.ts
│   ├── azure-search-bootstrap/                # Index creator Lambda (runs once via custom resource)
│   │   └── src/handler.ts
│   ├── notification-cap-enforcer/             # DynamoDB ADD + quiet hours gate
│   │   └── src/handler.ts
│   └── vps-freeze-patched/                    # Patched VPS scripts (sync target, NOT Lambda)
│       ├── classify_and_save.py
│       ├── morning_briefing.py
│       └── evening_checkin.py
├── scripts/
│   ├── deploy.sh                              # cdk diff → review → cdk deploy
│   ├── backfill-notion.sh                     # Invokes backfill Lambda
│   └── deploy-vps-freeze.sh                   # rsync patched scripts to 98.91.6.66
└── .planning/
```

### Pattern 1: KosLambda Construct (defaults for every Lambda in Phase 1)

**What:** Single wrapper that applies consistent defaults: Node.js 22.x, esbuild bundling, `@aws-sdk/*` externalized, `NODE_OPTIONS=--enable-source-maps`, CloudWatch log retention 30 days, structured JSON logging.

**When to use:** All Lambdas in Phase 1 (notion-indexer, backfill, vocab-deploy, azure-bootstrap, notification-cap).

**Example:**

```typescript
// Source: AWS CDK v2 NodejsFunction docs
// https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html
import { NodejsFunction, BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export interface KosLambdaProps {
  entry: string;         // path to .ts entry file
  handler?: string;      // default 'handler'
  timeout?: Duration;    // default Duration.seconds(30)
  memory?: number;       // default 512
  environment?: Record<string, string>;
  vpc?: IVpc;            // set for functions that reach RDS
  vpcSubnets?: SubnetSelection;
  securityGroups?: ISecurityGroup[];
}

export class KosLambda extends NodejsFunction {
  constructor(scope: Construct, id: string, props: KosLambdaProps) {
    super(scope, id, {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,    // cheaper, faster cold starts
      timeout: props.timeout ?? Duration.seconds(30),
      memorySize: props.memory ?? 512,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        TZ: 'UTC',                          // do NOT use Europe/Stockholm here — compute in code
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],    // runtime-provided in Node.js 22.x
        format: OutputFormat.ESM,
      },
      logRetention: RetentionDays.ONE_MONTH,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: props.securityGroups,
    });
  }
}
```

**Notes:**
- `externalModules: ['@aws-sdk/*']` is critical — SDK v3 is ~50MB bundled; externalizing drops Lambda zip to <2MB and cold-start to sub-200ms [CITED: AWS CDK NodejsFunction docs].
- ARM_64 (Graviton) saves ~20% vs x86_64 at same performance for Node.js workloads [CITED: AWS pricing].
- Do NOT set `TZ=Europe/Stockholm` env var — the `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})` pattern is more explicit and testable.

### Pattern 2: Cross-Stack References via `CfnOutput` / `Fn.importValue` OR Direct Props

**What:** Pass resources between stacks. Two options: (a) export CfnOutput in producing stack, import via `Fn.importValue` in consumer; (b) pass the construct reference directly via props when stacks share the same CDK app.

**When to use:** (b) direct props — simpler, type-safe, matches how the 5 Phase 1 stacks are co-deployed from the same `bin/kos.ts`.

**Example:**

```typescript
// bin/kos.ts
const network = new NetworkStack(app, 'KosNetwork', { env });
const data = new DataStack(app, 'KosData', { env, vpc: network.vpc, s3Endpoint: network.s3GatewayEndpoint });
const events = new EventsStack(app, 'KosEvents', { env });
const integrations = new IntegrationsStack(app, 'KosIntegrations', {
  env,
  vpc: network.vpc,
  rdsSecret: data.rdsCredentialsSecret,
  notionTokenSecret: data.notionTokenSecret,
  eventBuses: events.buses,
});
const safety = new SafetyStack(app, 'KosSafety', {
  env,
  eventBuses: events.buses,
  alarmEmail: 'kevin@tale-forge.app',
});
```

**Notes:**
- Each stack exposes public readonly properties for its resources (e.g., `public readonly vpc: IVpc`).
- Cross-account / cross-region references would need `CfnOutput` + `Fn.importValue`; KOS is single-account single-region so direct props win.

### Pattern 3: Drizzle Schema with Built-In pgvector

**What:** Use Drizzle 0.31+'s built-in `vector()` column type; do NOT hand-roll a customType.

**When to use:** Any column holding embeddings (future use in Phase 6; Phase 1 creates the column but doesn't populate).

**Example:**

```typescript
// packages/db/schema.ts
// Source: https://orm.drizzle.team/docs/guides/vector-similarity-search (Drizzle 0.31+)
import { pgTable, uuid, text, timestamp, index, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const entityIndex = pgTable('entity_index', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull(),            // Gate 1 crossover: every table has owner_id
  notionPageId: text('notion_page_id').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),                   // Person | Project | Company | Document
  org: text('org'),
  role: text('role'),
  relationship: text('relationship'),
  status: text('status'),
  seedContext: text('seed_context'),
  lastTouch: timestamp('last_touch', { withTimezone: true }),
  embedding: vector('embedding', { dimensions: 1536 }),  // Titan/OpenAI dims; populated Phase 6
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byOwnerType: index('entity_index_by_owner_type').on(table.ownerId, table.type),
  // HNSW index defined in raw SQL migration — Drizzle doesn't yet express HNSW options
}));
```

**HNSW index — raw SQL in migration:**

```sql
-- packages/db/migrations/0002_hnsw_index.sql
-- Created Phase 1; populated Phase 6
-- pgvector 0.8.0 on RDS PostgreSQL 16.5+ supports HNSW
-- https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/
CREATE INDEX entity_index_embedding_hnsw
  ON entity_index
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Notes:**
- pgvector 0.8.0 is available on RDS PostgreSQL 16.5+ — pin the parameter group to `postgres16`, minor version 16.5 or higher [CITED: aws.amazon.com/about-aws/whats-new/2024/11].
- Aurora HNSW capacity-scaling issue does NOT apply — Phase 1 uses provisioned RDS, not Aurora Serverless v2. This is confirmed safe. [CITED: D-07 locks RDS provisioned]

### Pattern 4: Notion Indexer — Cursor + 2-Min Overlap + Idempotent Upsert

**What:** Each watched DB has a row in `notion_indexer_cursor(db_id, last_cursor_at)`. Every 5 min, Scheduler invokes indexer Lambda with the `db_id`. Lambda queries Notion with `filter.timestamp=last_edited_time, after=(last_cursor_at − 2min)`, paginates (100 per page), upserts to RDS keyed on `(notion_page_id)` with a check that incoming `last_edited_time > stored.last_edited_time` before writing.

**When to use:** The steady-state indexer. The one-shot backfill Lambda uses the same upsert logic but queries without the timestamp filter.

**Example:**

```typescript
// services/notion-indexer/src/handler.ts
import { Client } from '@notionhq/client';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
// Source: https://developers.notion.com/reference/query-a-data-source

export async function handler(event: { dbId: string; dbKind: 'entities' | 'projects' | 'kevin_context' | 'command_center' }) {
  const db = drizzle(pgClient);
  const cursor = await db.execute(sql`SELECT last_cursor_at FROM notion_indexer_cursor WHERE db_id = ${event.dbId}`);
  const lastCursor = cursor.rows[0]?.last_cursor_at ?? new Date(0);
  const overlap = new Date(lastCursor.getTime() - 2 * 60 * 1000);  // 2-min overlap per D-08

  let startCursor: string | undefined = undefined;
  let maxSeenEditedAt = lastCursor;

  do {
    const res = await notion.databases.query({
      database_id: event.dbId,
      filter: { timestamp: 'last_edited_time', last_edited_time: { after: overlap.toISOString() } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      start_cursor: startCursor,
      page_size: 100,
    });

    for (const page of res.results) {
      // ... upsert keyed on notion_page_id; skip if stored.last_edited_time >= page.last_edited_time
      // ... Status='Archived' flows; hard-deletes (404 on retrieve) are logged + skipped (archive-not-delete)
      const editedAt = new Date((page as any).last_edited_time);
      if (editedAt > maxSeenEditedAt) maxSeenEditedAt = editedAt;
    }

    startCursor = res.next_cursor ?? undefined;
  } while (startCursor);

  // Commit cursor advance
  await db.execute(sql`
    INSERT INTO notion_indexer_cursor(db_id, last_cursor_at) VALUES (${event.dbId}, ${maxSeenEditedAt})
    ON CONFLICT (db_id) DO UPDATE SET last_cursor_at = EXCLUDED.last_cursor_at
  `);
}
```

**Notes:**
- Notion rate limit is 3 req/s per integration [CITED: developers.notion.com/reference/request-limits]. Query-a-DB call is one request per page (100 pages). Indexer sleeps if it sees 429 with exponential backoff + jitter.
- Pagination: Notion uses `start_cursor` / `next_cursor` [CITED: developers.notion.com/reference/query-a-data-source]; `page_size` max 100.
- Cursor advance only after full pagination completes — if mid-page failure occurs, next run picks up from (old cursor − 2 min), re-processing is idempotent.
- Status=Archived is a property value change, not a deletion. Normal upsert flows it. Notion API `archived:true` at the page-level (trash can) returns 404 on retrieve — this is the hard-delete case; indexer logs + skips (archive-not-delete).

### Pattern 5: Azure AI Search Index with Binary Quantization at Creation

**What:** POST to `https://{service}.search.windows.net/indexes?api-version=2025-09-01` with a payload that includes `vectorSearch.compressions[]` referencing a `binaryQuantization` block. Must be set at CREATE time; retrofit requires full re-index.

**When to use:** The `azure-search-bootstrap` Lambda (CDK custom resource) runs once on first deploy.

**Example:**

```json
// Source: https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-quantization
// and https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-index-binary-data
{
  "name": "kos-memory-v1",
  "fields": [
    { "name": "id", "type": "Edm.String", "key": true, "filterable": true },
    { "name": "content", "type": "Edm.String", "searchable": true, "analyzer": "standard.lucene" },
    { "name": "entity_ids", "type": "Collection(Edm.String)", "filterable": true },
    { "name": "source", "type": "Edm.String", "filterable": true, "facetable": true },
    { "name": "occurred_at", "type": "Edm.DateTimeOffset", "filterable": true, "sortable": true },
    {
      "name": "content_vector",
      "type": "Collection(Edm.Single)",
      "dimensions": 1536,
      "vectorSearchProfile": "kos-hnsw-binary"
    }
  ],
  "vectorSearch": {
    "algorithms": [
      {
        "name": "kos-hnsw",
        "kind": "hnsw",
        "hnswParameters": { "m": 4, "efConstruction": 400, "efSearch": 500, "metric": "cosine" }
      }
    ],
    "compressions": [
      {
        "name": "kos-binary-compression",
        "kind": "binaryQuantization",
        "rescoringOptions": {
          "enableRescoring": true,
          "defaultOversampling": 10,
          "rescoreStorageMethod": "preserveOriginals"
        }
      }
    ],
    "profiles": [
      { "name": "kos-hnsw-binary", "algorithm": "kos-hnsw", "compression": "kos-binary-compression" }
    ]
  },
  "semantic": {
    "configurations": [
      {
        "name": "kos-semantic",
        "prioritizedFields": {
          "contentFields": [{ "fieldName": "content" }],
          "keywordsFields": [{ "fieldName": "entity_ids" }]
        }
      }
    ]
  }
}
```

**Notes:**
- `binaryQuantization` with `rescoreStorageMethod: "preserveOriginals"` keeps the full-precision vectors for re-ranking, giving the best quality/cost tradeoff [CITED: learn.microsoft.com/en-us/azure/search/vector-search-how-to-quantization].
- 92.5% cost reduction claim is Microsoft-published and requires this exact configuration [CITED: techcommunity.microsoft.com/blog/azure-ai-foundry-blog/4404866].
- Binary quantization retrofit = full reindex — confirmed. Get it right first time; verify via `GET /indexes/kos-memory-v1?api-version=2025-09-01` immediately after create and assert `vectorSearch.compressions[0].kind === 'binaryQuantization'`.
- Basic tier semantic reranker quota: 1000 free queries/month; $5.38/1K thereafter [CITED: azure.microsoft.com pricing].

### Pattern 6: DynamoDB Notification Cap — ADD + TTL + Stockholm Key

**What:** Single-key table, `PK = "telegram-cap#${stockholmDate}"`, attribute `count` incremented via `ADD`, attribute `ttl` = `(stockholmDate + 2 days).unix()`.

**When to use:** Every outbound Telegram push (used starting Phase 2; infrastructure lives in Phase 1).

**Example:**

```typescript
// services/notification-cap-enforcer/src/handler.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function stockholmDateKey(): string {
  // Source: Intl.DateTimeFormat pattern; toLocaleString("sv-SE") returns "2026-04-22 14:03:11"
  const sv = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  // sv format: "YYYY-MM-DD HH:MM:SS"
  return sv.split(' ')[0];  // "2026-04-22"
}

function stockholmHour(): number {
  const sv = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', hour12: false });
  return parseInt(sv, 10);
}

export async function enforceAndIncrement(): Promise<{ allowed: boolean; reason?: string }> {
  const hour = stockholmHour();
  if (hour >= 20 || hour < 8) {
    return { allowed: false, reason: 'quiet-hours' };   // D-13: queue to Notion Inbox instead
  }

  const dateKey = stockholmDateKey();
  const ttl = Math.floor(Date.now() / 1000) + 48 * 3600;  // 48h TTL

  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: process.env.CAP_TABLE!,
      Key: { pk: `telegram-cap#${dateKey}` },
      UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
      ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': ttl, ':max': 3 },
      ReturnValues: 'UPDATED_NEW',
    }));
    return { allowed: true };
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { allowed: false, reason: 'cap-exceeded' };
    }
    throw err;
  }
}
```

**Notes:**
- `ConditionExpression` enforces "≤ 3 sends" atomically — the classic DynamoDB rate-limit pattern [CITED: github.com/animir/node-rate-limiter-flexible/wiki/DynamoDB].
- TTL is epoch seconds (NOT ms) on a Number attribute [CITED: dynobase.dev/dynamodb-ttl].
- `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})` deterministically yields `YYYY-MM-DD HH:MM:SS` [VERIFIED: Intl spec — Swedish locale canonical for ISO-8601-like date format].
- On-demand billing mode chosen: at ≤5 writes/day, on-demand costs ~$0.00025/month — **cheaper than the $1.94/month minimum provisioned cost of 4 WCU** [CITED: alexdebrie.com/posts/dynamodb-costs].
- **Architecturally**: the cap enforcer is a shared library function imported by every Lambda that sends Telegram. In Phase 1, only a stub exists (no Telegram code yet); the function is deployed + unit-tested. Phase 2 wires `push-telegram` Lambda to import it.

### Pattern 7: VPS Freeze — Patched Scripts with Legacy Inbox Redirect

**What:** Edit each of the three VPS scripts to change a single constant (the Notion DB ID) from Command Center / Kontakter / Daily Brief Log to the new `Legacy Inbox` DB. Prepend `[MIGRERAD]` marker to the title of every row written.

**When to use:** Once, at end of Phase 1. Deployed via `rsync` over SSH.

**Example:**

```python
# services/vps-freeze-patched/classify_and_save.py (minimal diff)
# --- before ---
# NOTION_DB_ID = "abc123-command-center"
# --- after ---
NOTION_DB_ID = os.environ["LEGACY_INBOX_DB_ID"]   # set by /etc/kos-freeze.env

def save_row(title: str, payload: dict):
    marker_title = f"[MIGRERAD] {title}"
    # ... existing notion.pages.create call, unchanged
```

**Deployment script:**

```bash
# scripts/deploy-vps-freeze.sh
#!/usr/bin/env bash
set -euo pipefail
VPS=98.91.6.66
SSH_USER=kevin

# Copy patched scripts
rsync -avz services/vps-freeze-patched/ "$SSH_USER@$VPS:/opt/kos-vps/"

# Create / update env file with Legacy Inbox DB ID (injected from local env)
ssh "$SSH_USER@$VPS" "cat > /etc/kos-freeze.env <<EOF
LEGACY_INBOX_DB_ID=${LEGACY_INBOX_DB_ID}
NOTION_TOKEN=${NOTION_TOKEN_VPS}
EOF"

# Reload systemd units (scripts are run via existing systemd timers — no n8n changes)
ssh "$SSH_USER@$VPS" "sudo systemctl daemon-reload && sudo systemctl restart kos-classify kos-morning kos-evening"
echo "VPS freeze deployed — scripts now write to Legacy Inbox"
```

**Verification:**

```bash
# 1. Trigger a manual run
ssh kevin@98.91.6.66 "sudo systemctl start kos-classify.service"

# 2. Confirm new Notion row appears in Legacy Inbox with [MIGRERAD] prefix
curl -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" \
  "https://api.notion.com/v1/databases/$LEGACY_INBOX_DB_ID/query" | jq '.results[0].properties.Name.title[0].plain_text'
# expect: "[MIGRERAD] ..."

# 3. Confirm Command Center gets zero new rows from classify_and_save for 48h
```

**Notes:**
- n8n stays running. Brain-dump-listener stays running. gmail_classifier stays running. Only the three write-path scripts get patched — matches D-14 scope exactly.
- Existing SSH tooling: the repo has no existing scripts/ directory; this is the first deployment automation. One-time manual step: Kevin confirms SSH key is in `~/.ssh/authorized_keys` on VPS and that his workstation can reach 98.91.6.66:22.
- Reversibility: original scripts preserved in VPS `/opt/kos-vps/original/` before patch.

### Anti-Patterns to Avoid

- **Monolithic CDK stack:** 5-stack split (D-01) is intentional — a single `KosStack` would couple RDS changes to EventBridge changes, risking CloudFormation rollback of the wrong resource on failure.
- **Drizzle `push` in production:** `drizzle-kit push` skips the migrations/ folder and applies schema diff directly. No audit trail. Use `drizzle-kit generate` + `drizzle-kit migrate`.
- **Custom pgvector type in Drizzle 0.31+:** Built-in `vector()` exists — only write `customType<>()` if the dimensions must be dynamic (they aren't).
- **CloudWatch billing alarms:** Billing metrics only exist in `us-east-1`; CDK billing alarms in a eu-north-1 stack require `env: { region: 'us-east-1' }` contortion. **AWS Budgets is the current recommended approach** [CITED: docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html].
- **Auto-confirming SNS email subscription:** Not possible. CDK creates the subscription in `PendingConfirmation` state; Kevin must click the link in the confirmation email. Plan must include a post-deploy verification step.
- **Running notification cap as a separate EventBridge rule target:** The cap MUST live inline in every code path that sends Telegram, because it's protecting against bugs in the caller. A separate rule target can be bypassed by a direct Telegram SDK call from an agent. Architectural home: shared package imported by all sender Lambdas.
- **Transcribe `IdentifyLanguage: true`:** Swedish is not in language-ID; will misidentify as English [CITED: docs.aws.amazon.com/transcribe/latest/dg/lang-id.html]. Always pass explicit `LanguageCode: 'sv-SE'`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Lambda TypeScript bundling | Custom esbuild invocation via CodeBuild | `aws-cdk-lib/aws-lambda-nodejs` NodejsFunction | Handles esbuild + source maps + Docker fallback in 10 lines |
| pgvector column type | Custom `customType<>()` pattern | Drizzle 0.31+ `vector('col', {dimensions: N})` | Built-in type exists; avoid the drizzle-team/drizzle-orm issue #5358 gotcha (customType + getTableColumns returns wrong value) [CITED: GitHub issue] |
| Notion rate-limit backoff | Hand-rolled `if err.status === 429 { await sleep(...) }` | `@notionhq/client` retries internally + explicit SQS FIFO if bulk | The client handles transient 429 with automatic retry-after; only add queueing for bulk backfill |
| DynamoDB atomic increment with cap | Read-then-conditionalPut pattern | Single `UpdateCommand` with `ADD` + `ConditionExpression` | Atomic on server side; read-then-write has a race window |
| Cost alarm routing | Lambda polling CostExplorer + custom threshold logic | AWS Budgets native SNS action | Budgets is AWS's managed cost product; free; $50/$100 thresholds are 5 lines of CDK |
| SNS email subscription confirmation | Automated confirmation via `ConfirmSubscription` API | Manual click by Kevin | AWS requires manual confirm to prevent spam; cannot be automated safely |
| Stockholm timezone math | `luxon` / `date-fns-tz` | Native `Intl` + `toLocaleString('sv-SE', {timeZone})` | Zero dependencies; handles DST automatically; idiomatic Node 22 |
| EventBridge cron-rule timezone | UTC cron with offset math | `Schedule.cron(..., { timeZone: 'Europe/Stockholm' })` on EventBridge Scheduler (NOT EventBridge rule) | Scheduler supports IANA timezones natively + DST; EventBridge rules do not [CITED: docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html] |
| S3 bucket-to-VPC access control | Per-Lambda execution role with `kms:Decrypt` + `s3:GetObject` manually | S3 bucket policy with `aws:SourceVpce` condition + S3 Gateway Endpoint auto-updates route tables | Gateway Endpoint is $0 and auto-routes; bucket policy scoping is two lines |

**Key insight:** Phase 1 is an exercise in assembling AWS-native and first-party SDKs correctly. The only place custom code is load-bearing is: (1) Notion indexer logic, (2) notification cap enforcement, (3) VPS-script patches. Everything else is wiring.

## Common Pitfalls

### Pitfall 1: SNS email subscription stays `PendingConfirmation` forever

**What goes wrong:** `cdk deploy` completes, but no cost alarm emails arrive. CloudFormation shows the subscription exists; the email just needs confirmation that Kevin missed (Gmail spam folder, or Kevin forgot).

**Why it happens:** AWS requires manual click-confirmation for email subscriptions. CDK marks deploy-complete as soon as the Subscription resource is created, which is technically `PendingConfirmation`.

**How to avoid:**
- Include a post-deploy verification step in the plan: `aws sns list-subscriptions-by-topic --topic-arn $ARN | jq '.Subscriptions[] | select(.SubscriptionArn == "PendingConfirmation")'` — if any rows, flag as incomplete.
- Subject line in the confirmation email matches `AWS Notification - Subscription Confirmation` — tell Kevin to whitelist before deploy.

**Warning signs:** A $50 budget threshold crossed in staging testing, but no email arrives.

### Pitfall 2: Bucket policy blocks Lambda even with Gateway Endpoint

**What goes wrong:** Bucket policy uses `aws:SourceIp` condition; traffic through Gateway Endpoint has no source IP from the internet; all requests deny with `403 Access Denied`.

**Why it happens:** `aws:SourceIp` doesn't work for VPC-endpoint traffic [CITED: aws.amazon.com/blogs/storage/managing-amazon-s3-access-with-vpc-endpoints-and-s3-access-points].

**How to avoid:** Use `aws:SourceVpce` (endpoint ID) or `aws:SourceVpc` (VPC ID) — never `aws:SourceIp`.

```json
{
  "Condition": {
    "StringEquals": { "aws:SourceVpce": "vpce-0abc123..." }
  }
}
```

**Warning signs:** `403` on PutObject / GetObject from Lambda-in-VPC to S3; CloudTrail shows `Requester` has `vpcEndpointId` set, but policy evaluation fails.

### Pitfall 3: Clock skew causes missed rows on 5-min poll

**What goes wrong:** Notion server time lags Lambda time by a few seconds. Lambda queries `last_edited_time > 10:05:00`; a page edited at 10:04:58 (Notion clock) but recorded at 10:05:02 (Lambda clock) is skipped.

**Why it happens:** Distributed systems. D-08's 2-min overlap exists specifically for this.

**How to avoid:** Always overlap by `2 minutes` when advancing the cursor: `overlap_from = last_cursor - 2min`. Stored cursor advances only to `max(seen_last_edited_time)`, not `now()` — so if no rows were seen, cursor stays put. Idempotent upsert handles duplicate processing of overlap rows.

**Warning signs:** Rows appear in Notion but never land in Postgres on first or second poll — they land on the third poll. Indicates overlap is too small OR cursor advance logic is wrong.

### Pitfall 4: pgvector extension not available on selected engine minor version

**What goes wrong:** RDS parameter group defaults to PostgreSQL 16.2; `CREATE EXTENSION vector` fails because pgvector 0.8.0 requires 16.5+.

**Why it happens:** RDS engine minor versions lag; defaults aren't always latest.

**How to avoid:** Pin `engineVersion: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_5 })` or higher. Verify before deploy:

```bash
aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[?starts_with(EngineVersion, `16.`)].EngineVersion'
```

**Warning signs:** Post-deploy SQL `CREATE EXTENSION vector;` returns `ERROR: extension "vector" is not available`.

### Pitfall 5: Drizzle pgvector column fails on ALTER TABLE

**What goes wrong:** Adding a `vector()` column via migration errors with `type vector(1536) does not exist` even though the extension is installed.

**Why it happens:** Confirmed issue — Drizzle emits the type name with quotes in ALTER TABLE contexts [CITED: drizzle-orm GitHub discussions].

**How to avoid:** Create the `embedding` column in the initial CREATE TABLE statement, not via a follow-up ALTER. If a follow-up ALTER is needed, write raw SQL in the migration file.

**Warning signs:** First migration after schema includes `embedding` column fails; works only when table is dropped + recreated.

### Pitfall 6: Stockholm DST transition breaks cap key or quiet hours

**What goes wrong:** On the "fall back" Sunday in October, 02:30 Stockholm happens twice. If any logic does `hour >= 20 || hour < 8` naively on UTC, the quiet-hour window shifts by 1 hour for 6 months.

**Why it happens:** Europe/Stockholm is CET (UTC+1) winter, CEST (UTC+2) summer.

**How to avoid:** ALL Stockholm math MUST use `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})` or `Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Stockholm', ...})`. Never subtract hours from UTC manually. EventBridge Scheduler's `ScheduleExpressionTimezone: 'Europe/Stockholm'` handles DST automatically [CITED: docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html].

**Warning signs:** Unit tests pass in April but fail in November; or morning brief fires at 06:00 instead of 07:00 after a clock change.

### Pitfall 7: AWS Transcribe SoundsLike / IPA columns silently ignored for Swedish

**What goes wrong:** Custom vocabulary table includes IPA pronunciations (`ˈaːlmi` for "Almi"); Transcribe accepts the vocabulary but does not use the IPA column for Swedish.

**Why it happens:** Per April 2026 AWS re:Post and supported-features matrix, **IPA and SoundsLike columns are deprecated/unsupported for Swedish** [CITED: AWS Transcribe "Creating a custom vocabulary using a table" docs, confirmed on re:Post QU_Aa3ot97TP-jYE-pQDCCzg].

**How to avoid:** Use the phrase-list format (single `Phrase` column with hyphen-separated compound tokens like `Tale-Forge`, `Tale-Forge-AB`, `OpenClaw`) rather than the table format with pronunciation columns. This is the only accuracy lever available for sv-SE.

**Warning signs:** Custom vocab deployed without error, but entity names still mis-transcribed after Phase 2 WER test.

## Runtime State Inventory

Phase 1 is mostly greenfield, but the VPS freeze introduces runtime state concerns. Categories:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None new in Phase 1. Existing Notion workspace has Entities (to be confirmed — may be new DB or reused), Projects, Kevin Context, Command Center, Transkripten, plus 5 Brain DBs (Phase 10 scope). Existing RDS: none (brand new). Existing VPS filesystem: `/opt/.../classify_and_save.py` etc. | Create new DBs (Entities / Projects / Kevin Context if not present / Legacy Inbox). No data migration in Phase 1. |
| Live service config | VPS systemd timers for classify_and_save, morning_briefing, evening_checkin, gmail_classifier, brain-dump-listener, sync_aggregated. n8n on VPS port 5678. | Edit only the 3 write-path scripts (plus `/etc/kos-freeze.env`); leave n8n untouched (D-14). |
| OS-registered state | VPS systemd services (presumed named `kos-classify`, `kos-morning`, `kos-evening` — verify exact names in deployment). | `systemctl restart` after rsync; no registration change. |
| Secrets/env vars | New: `KOS_DASHBOARD_BEARER` (placeholder), `NOTION_TOKEN_KOS` (real), `NOTION_TOKEN_VPS` (existing, reused), `AZURE_SEARCH_ADMIN_KEY` (real), `AZURE_SEARCH_ENDPOINT` (real), `RDS_CREDENTIALS` (auto-generated by CDK), `TELEGRAM_BOT_TOKEN` (placeholder — Phase 2 consumer). | Secrets Manager entries created by CDK as placeholders where values aren't yet known; Kevin provides real values via `aws secretsmanager put-secret-value` before dependent Lambdas execute. |
| Build artifacts / installed packages | None — no existing build output in repo. | None. |

**VPS-specific items:**
- Existing VPS scripts read `NOTION_TOKEN` from existing env (likely `~/.env` or `/etc/environment`). New `/etc/kos-freeze.env` adds `LEGACY_INBOX_DB_ID` without touching existing token.
- Original scripts backed up to `/opt/kos-vps/original/` before patch — reversibility preserved per D-14.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| AWS account + Bedrock IAM user | CDK deploy | ✓ (per code_context) | existing | — |
| AWS CLI v2 | `cdk deploy`, `aws sns list-subscriptions` verification | [ASSUMED: ✓] on dev workstation | — | `npx aws-cli` |
| Node.js 22.x | NodejsFunction local bundling; CDK runtime | [ASSUMED: ✓] | — | — |
| `npm` | install deps | [ASSUMED: ✓] | — | — |
| `esbuild` (local) | NodejsFunction bundling (avoid slow Docker on Windows) | Not yet installed | — | Docker Desktop (slow on Windows per AWS CDK docs) |
| Docker Desktop | Fallback for NodejsFunction bundling | Not required if esbuild local | — | — |
| `drizzle-kit` CLI | migration generation | npm-installed | — | — |
| Notion integration token (existing Kevin workspace) | Create new DBs; validate workspace access | Existing (per code_context) | — | — |
| Notion workspace plan | Phase 1 ships on current plan; EU residency is a separate concern (see Open Questions) | Plan unknown [ASSUMED] | — | — |
| Azure subscription + credits | Azure AI Search provisioning | ✓ $5k credits | — | — |
| Azure CLI (`az`) | Bootstrap verification | [ASSUMED: ✓] | — | use Azure portal manually |
| SSH access to 98.91.6.66 | VPS freeze deployment | [ASSUMED: ✓] from Kevin's workstation | — | Manual scp + ssh |
| `rsync` | VPS script deploy | [ASSUMED: ✓ on Kevin's workstation] | — | `scp -r` |

**Missing dependencies with no fallback:** None that block Phase 1 start.

**Missing dependencies with fallback:** `esbuild` local install recommended before first `cdk deploy` on Windows (Docker fallback is ~10× slower for bundling).

**Planner action:** Include a Wave 0 task to verify local environment: `node --version` (≥22), `aws sts get-caller-identity`, `az account show`, `ssh kevin@98.91.6.66 'echo ok'`, `npm install -g esbuild` (or add to devDependencies).

## Code Examples

### Example: CDK NetworkStack with S3 Gateway Endpoint

```typescript
// cdk/lib/stacks/network-stack.ts
// Source: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.GatewayVpcEndpoint.html
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Vpc, SubnetType, GatewayVpcEndpointAwsService, IVpc, IGatewayVpcEndpoint,
} from 'aws-cdk-lib/aws-ec2';

export class NetworkStack extends Stack {
  public readonly vpc: IVpc;
  public readonly s3GatewayEndpoint: IGatewayVpcEndpoint;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'KosVpc', {
      ipAddresses: IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2,                                       // eu-north-1a, eu-north-1b for RDS subnet group
      natGateways: 0,                                  // D-05: no NAT in Phase 1
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: GatewayVpcEndpointAwsService.S3 },   // D-06: only S3 in Phase 1
      },
    });

    this.s3GatewayEndpoint = this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });
    // Note: `gatewayEndpoints` in VPC config and addGatewayEndpoint BOTH work — pick one; shown both for clarity
  }
}
```

### Example: DataStack — RDS with pgvector + S3 with VPC-scoped bucket policy

```typescript
// cdk/lib/stacks/data-stack.ts
// Source: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds-readme.html
import {
  DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion, Credentials,
} from 'aws-cdk-lib/aws-rds';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { RemovalPolicy, Duration } from 'aws-cdk-lib';
import { InstanceType, InstanceClass, InstanceSize, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement, Effect, AnyPrincipal } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export interface DataStackProps extends StackProps {
  vpc: IVpc;
  s3Endpoint: IGatewayVpcEndpoint;
}

export class DataStack extends Stack {
  public readonly rds: DatabaseInstance;
  public readonly rdsCredentialsSecret: ISecret;
  public readonly audioBucket: Bucket;
  public readonly notionTokenSecret: Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // --- RDS ---
    this.rds = new DatabaseInstance(this, 'KosRds', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_5 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      multiAz: false,                                  // D-07
      storageEncrypted: true,
      backupRetention: Duration.days(7),               // D-07
      removalPolicy: RemovalPolicy.RETAIN,             // D-03
      deletionProtection: true,
      credentials: Credentials.fromGeneratedSecret('kos_admin'),
      parameterGroup: new ParameterGroup(this, 'KosPg', {
        engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_5 }),
        parameters: {
          // pgvector 0.8.0 requires shared_preload_libraries includes 'vector' for certain features
          // In RDS, 'vector' is pre-loaded automatically; no parameter change required
          'rds.force_ssl': '1',
        },
      }),
    });
    this.rdsCredentialsSecret = this.rds.secret!;

    // --- Audio / documents / transcripts bucket ---
    this.audioBucket = new Bucket(this, 'KosBlobs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,             // D-03
      versioned: true,
    });

    // Bucket policy: allow only requests from the S3 Gateway Endpoint
    this.audioBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.DENY,
      principals: [new AnyPrincipal()],
      actions: ['s3:*'],
      resources: [this.audioBucket.bucketArn, `${this.audioBucket.bucketArn}/*`],
      conditions: {
        StringNotEquals: { 'aws:SourceVpce': props.s3Endpoint.vpcEndpointId },
      },
    }));

    // --- Secrets ---
    this.notionTokenSecret = new Secret(this, 'NotionToken', {
      secretName: 'kos/notion-token',
      description: 'Notion integration token (Kevin workspace)',
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
```

### Example: EventsStack — 5 buses with DLQs

```typescript
// cdk/lib/stacks/events-stack.ts
// Source: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_events-readme.html
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';

export class EventsStack extends Stack {
  public readonly buses: Record<'capture' | 'triage' | 'agent' | 'output' | 'system', EventBus>;
  public readonly defaultDlq: Queue;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.defaultDlq = new Queue(this, 'KosDlq', {
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });

    const names = ['capture', 'triage', 'agent', 'output', 'system'] as const;
    this.buses = Object.fromEntries(
      names.map(n => [n, new EventBus(this, `KosBus-${n}`, { eventBusName: `kos.${n}` })])
    ) as any;
    // Rules + targets live in IntegrationsStack / SafetyStack / downstream phases
  }
}
```

### Example: Transcribe custom vocabulary via CDK custom resource

```typescript
// cdk/lib/stacks/integrations-stack.ts (excerpt)
// Deploys Transcribe vocab file from S3 to a named Transcribe vocabulary via custom resource Lambda
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';

const vocabResource = new AwsCustomResource(this, 'TranscribeVocab', {
  onCreate: {
    service: 'Transcribe',
    action: 'createVocabulary',
    parameters: {
      VocabularyName: 'kos-sv-se-v1',
      LanguageCode: 'sv-SE',
      VocabularyFileUri: `s3://${vocabBucket.bucketName}/vocab/sv-se-v1.txt`,
    },
    physicalResourceId: PhysicalResourceId.of('kos-sv-se-v1'),
  },
  onUpdate: {
    service: 'Transcribe',
    action: 'updateVocabulary',
    parameters: { VocabularyName: 'kos-sv-se-v1', LanguageCode: 'sv-SE', VocabularyFileUri: '...' },
    physicalResourceId: PhysicalResourceId.of('kos-sv-se-v1'),
  },
  policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
});
// File format (phrase-only, one token per line, hyphenated compounds):
// Kevin
// Tale-Forge
// Outbehaving
// Almi
// Damien
// Christina
// konvertibellån
```

**Vocab versioning strategy:** Name pattern `kos-sv-se-vN`. To roll forward:
1. Upload `vocab/sv-se-v2.txt` to S3.
2. Bump CDK constant to `'kos-sv-se-v2'`; `cdk deploy` creates new vocabulary (old one remains).
3. Update Transcribe consumers (Phase 2) to reference v2. Old vocabulary can be deleted out-of-band when no jobs reference it.

Zero-downtime because vocabularies are referenced by name at job-start time, not bound at deploy.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| CloudWatch billing alarms | AWS Budgets | 2024+ AWS guidance | Budgets is multi-region, supports forecasts, free; CloudWatch billing metric only in us-east-1 |
| Drizzle `customType` for pgvector | Built-in `vector()` in drizzle-orm 0.31+ | Drizzle 0.31 release | No more customType boilerplate |
| EventBridge cron rules with UTC | EventBridge Scheduler with IANA timezone | EventBridge Scheduler GA + CDK L2 April 2025 | DST handled automatically; single source of truth |
| Lambda AWS SDK v2 bundled | Lambda Node.js 22 ships SDK v3 | Node.js 22 runtime GA | Externalize `@aws-sdk/*` for smaller bundles |
| Azure AI Search vector compression opt-in later | Binary quantization at index creation | `2025-09-01` API stable | Cannot retrofit — force getting it right first time |

**Deprecated/outdated:**
- AWS Transcribe `SoundsLike` / `IPA` columns for Swedish custom vocabulary — appear deprecated; use phrase-only format.
- RDS PostgreSQL 16 versions before 16.5 — pgvector 0.8.0 unavailable; pin 16.5+.
- CloudWatch `AWS/Billing` metric alarms in non-us-east-1 stacks — use AWS Budgets.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Drizzle 0.31+ is latest stable and has built-in `vector()` type | Standard Stack | MEDIUM — verify with `npm view drizzle-orm version`; if not 0.31, fall back to customType |
| A2 | aws-cdk-lib 2.248.x is latest stable | Standard Stack | LOW — any recent aws-cdk-lib v2 works; pin at plan time |
| A3 | `@azure/search-documents` supports REST API `2025-09-01` with binary quantization | Standard Stack | MEDIUM — if SDK lags API, fall back to direct fetch with API version string |
| A4 | AWS CLI is installed on Kevin's workstation | Environment Availability | LOW — trivial install |
| A5 | Kevin has SSH access to 98.91.6.66 from his workstation | Environment Availability | LOW — Kevin operates the VPS today |
| A6 | VPS scripts are invoked by systemd timers named `kos-classify.service`, etc. | VPS Freeze | MEDIUM — service names must be verified during Wave 0 before deploy-vps-freeze.sh ships |
| A7 | Existing VPS scripts are Python and read `NOTION_TOKEN` from environment | VPS Freeze | MEDIUM — code_context doesn't specify language; Python assumed from ecosystem conventions |
| A8 | Notion integration token already exists and has access to Kevin's workspace | Environment Availability | LOW — code_context confirms "AWS account (existing, has Bedrock IAM user wired)"; assumes same for Notion |
| A9 | AWS Transcribe sv-SE batch is available in eu-north-1 | AWS Transcribe section | HIGH — one AWS announcement says batch in Stockholm (Oct 2021); official region table does not list it. **Wave 0 MUST verify** via `aws transcribe list-vocabularies --region eu-north-1` or AWS region-service table lookup. If unavailable, fall back to eu-west-1 (Ireland) |
| A10 | Notion workspace plan supports API-driven DB creation (Pro tier or above) | Notion DB bootstrap | LOW — `databases.create` is on the public API and works on any plan with an integration |
| A11 | Binary quantization cost reduction of 92.5% cited applies at KOS volume | Azure section | LOW — Microsoft benchmark is volume-agnostic for the compression factor itself |
| A12 | Bedrock Sonnet 4.6 / Haiku 4.5 do not need to be available in eu-north-1 for Phase 1 | Open Questions | LOW — Phase 1 has no agent calls; deferred to Phase 2 |
| A13 | Sending Notion 100-page queries at 3 req/s won't trigger workspace-level rate limits | Notion indexer | LOW — 3 req/s is per integration, not per-DB; indexer is well-behaved |
| A14 | Existing Hetzner VPS SSH port is 22 | VPS Freeze | LOW — standard default |
| A15 | `@anthropic-ai/claude-agent-sdk` is NOT needed in Phase 1 | Scope | HIGH if wrong — but Phase 1 has no agent code per CONTEXT.md boundary |
| A16 | Redis (ElastiCache) is NOT needed in Phase 1 | Scope | LOW — ElastiCache is EmailEngine's dep (Phase 4); dossier cache is Phase 6 |

**Planner-visible risk:** A9 (Transcribe in eu-north-1) is the only high-risk assumption that could cause scope drift. Put a Wave 0 verification task FIRST: `aws transcribe list-vocabularies --region eu-north-1 --max-results 1` — if this returns HTTP 200 with any valid response (even empty list), Transcribe is available there.

## Open Questions

1. **AWS Transcribe sv-SE regional availability in eu-north-1**
   - What we know: October 2021 AWS announcement listed Stockholm for batch; recent region-service tables are ambiguous.
   - What's unclear: Current (April 2026) availability of both batch and streaming.
   - Recommendation: Wave 0 CLI verification — one command. If unavailable, deploy Transcribe integration in eu-west-1 and accept ~30ms cross-region hop on voice processing (Phase 2 concern).

2. **Bedrock Sonnet 4.6 / Haiku 4.5 in eu-north-1**
   - What we know: Claude Opus 4.7 launched in eu-north-1 per April 2026 AWS blog. Sonnet 4.6 + Haiku 4.5 regional availability unclear; Global CRIS routing is available.
   - What's unclear: Whether eu-north-1 is a first-class region endpoint for Sonnet 4.6 / Haiku 4.5, or only via CRIS (cross-region routing).
   - Recommendation: Not blocking Phase 1 (no agent calls). Defer to Phase 2 research. If CRIS-only, that adds latency but no data-residency change (Bedrock doesn't persist inputs).

3. **Notion workspace EU data residency**
   - What we know: Notion offers EU data residency on **Enterprise** plan only; must request migration via account team or `enterprise@notion.so` [CITED: notion.com/help/data-residency].
   - What's unclear: Kevin's current plan tier (Pro vs Team vs Business vs Enterprise). GDPR position depends on this.
   - Recommendation: Plan a single task for Kevin to verify + request migration if needed. Not a deploy blocker — even US-hosted Notion is GDPR-compliant via SCCs, but EU-hosted is cleaner for the EU-first constraint. **Decision gate before Phase 2 production data lands in workspace.**

4. **Exact existing VPS service/script file layout**
   - What we know: VPS runs classify_and_save.py, morning_briefing.py, evening_checkin.py, gmail_classifier.py, brain-dump-listener, sync_aggregated, n8n on 5678 [per code_context].
   - What's unclear: Script paths, systemd unit names, Python vs other language, current Notion DB constants hardcoded vs env-var.
   - Recommendation: Wave 0 task — SSH to VPS, `systemctl list-units | grep -i kos`, `cat /opt/.../classify_and_save.py` to confirm structure before writing patched versions.

5. **Redis for notion-indexer rate-limit buffer (future)**
   - What we know: Phase 1 does not include ElastiCache.
   - What's unclear: Whether peak indexer load (backfill of 4 DBs × hundreds of pages) will hit Notion 429s without an SQS FIFO queue or Redis token bucket.
   - Recommendation: Ship plain indexer first; instrument 429 count; add queueing in a later phase if observed. Backfill Lambda can use local token bucket (leaky-bucket in-memory) for the one-shot run.

6. **Secrets Manager placeholder vs real-value policy**
   - What we know: Some secrets must be created with placeholder values at deploy (Telegram bot token — Phase 2); others need real values (Notion token — Phase 1 indexer can't run without it).
   - What's unclear: Clean mechanism — CDK `Secret.fromSecretCompleteArn` for pre-existing, or `new Secret` with `secretValueBeta1`, or out-of-band `aws secretsmanager put-secret-value` after deploy.
   - Recommendation: Plan creates empty secrets via CDK (names only); Kevin populates via `aws secretsmanager put-secret-value` before first invocation of dependent Lambda. Wave 0 task: a `scripts/seed-secrets.sh` that prompts for each required value and writes it.

## Project Constraints (from CLAUDE.md)

Directives the planner MUST honor:

- **Language stack:** TypeScript primary; CLAUDE.md lists grammY v1.38+ for Telegram (not python-telegram-bot) and avoids Python runtime in TS monorepo. Phase 1 has no Telegram code but VPS freeze scripts remain Python (existing code; not a new runtime addition).
- **Database:** RDS PostgreSQL 16 db.t4g.medium, pgvector yes. **Aurora Serverless v2 explicitly forbidden** (HNSW capacity scaling issue + 17% cost premium).
- **Vector DB policy:** pgvector + Azure AI Search. Pinecone / Weaviate / Qdrant **forbidden**.
- **Real-time:** SSE via Postgres LISTEN/NOTIFY (Phase 3 concern). AppSync / Pusher / Supabase Realtime **forbidden**.
- **Auth:** Static Bearer in Secrets Manager. Cognito / Clerk **forbidden**.
- **Routing:** AWS EventBridge. n8n (new) **forbidden**. Existing VPS n8n stays running per D-14.
- **Lambda runtime:** Node.js 22.x (runtime `nodejs22.x`).
- **Fargate platform:** 1.4.0, ARM64.
- **Observability:** CloudWatch 30-day retention default; Langfuse + Sentry deferred to Phase 2 (CONTEXT.md defers).
- **Region:** eu-north-1 for RDS, S3, EventBridge, Lambda, Secrets Manager. Azure AI Search West Europe (Amsterdam). Bedrock us-east-1 acceptable because inference doesn't persist data.
- **Removal policy:** RETAIN on stateful (D-03 echoes CLAUDE.md spirit).
- **Cost:** Aim ~$200-400/mo steady state. Phase 1 alone adds ~$3 (RDS + S3 + DynamoDB + Lambda) plus ~$75/mo Azure (covered by credits).

## Validation Architecture

> Required — `workflow.nyquist_validation: true` per `.planning/config.json`.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | **Vitest 1.6+** for unit/integration (fast, TypeScript-native, watch mode); `aws-cdk` CLI for CDK assertions; `bash` + `curl`/`aws-cli`/`jq` for post-deploy integration checks |
| Config file | `vitest.config.ts` (Wave 0 — see Gaps) |
| Quick run command | `npm run test:unit` → `vitest run --config vitest.unit.config.ts` |
| Full suite command | `npm run test` → `vitest run && npm run test:cdk && npm run test:integration` |
| CDK synth check | `cd cdk && npx cdk synth --all` |
| CDK diff check | `cd cdk && npx cdk diff` |
| Post-deploy integration | `bash scripts/verify-gate-1.sh` |

### Phase Requirements → Test Map

Every Gate 1 criterion must be independently testable:

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INF-01 | `cdk synth` produces valid CloudFormation for 5 stacks | unit (snapshot) | `npx cdk synth --all --quiet` | ❌ Wave 0 |
| INF-01 | All 5 stacks deploy cleanly | integration | `bash scripts/verify-stacks-exist.sh` | ❌ Wave 0 |
| INF-02 | pgvector extension present | integration | `psql -h $RDS_HOST -c "SELECT extversion FROM pg_extension WHERE extname='vector'"` (expect 0.8.0+) | ❌ Wave 0 |
| INF-02 | RDS eu-north-1 db.t4g.medium confirmed | integration | `aws rds describe-db-instances --region eu-north-1 --db-instance-identifier $ID --query 'DBInstances[0].DBInstanceClass'` (expect `db.t4g.medium`) | ❌ Wave 0 |
| INF-02 | All tables have `owner_id` column | unit | `vitest run packages/db/schema.test.ts` — iterates schema, asserts column presence | ❌ Wave 0 |
| INF-02 | Drizzle migrations apply clean on empty DB | integration | `drizzle-kit migrate` against scratch RDS | ❌ Wave 0 |
| INF-03 | S3 bucket exists in eu-north-1 with RETAIN policy | integration | `aws s3api get-bucket-location --bucket $BUCKET` + `aws cloudformation describe-stacks` parse | ❌ Wave 0 |
| INF-03 | S3 Gateway Endpoint routes Lambda→S3 traffic without NAT | integration | Test Lambda (VPC, private subnet, no NAT) calls `s3.getObject`; assert success + `$0 NAT Gateway processed-bytes` in CloudWatch | ❌ Wave 0 |
| INF-04 | All 5 EventBridge buses exist | integration | `for b in capture triage agent output system; do aws events describe-event-bus --name "kos.$b"; done` | ❌ Wave 0 |
| INF-07 | Every required Secrets Manager entry exists | integration | `aws secretsmanager list-secrets --filters Key=tag-key,Values=kos` | ❌ Wave 0 |
| INF-08 | Custom vocabulary `kos-sv-se-v1` deployed with State=READY | integration | `aws transcribe get-vocabulary --vocabulary-name kos-sv-se-v1 --query 'VocabularyState'` (expect `READY`) | ❌ Wave 0 |
| INF-09 | Azure AI Search index exists | integration | `curl "$AZURE_ENDPOINT/indexes/kos-memory-v1?api-version=2025-09-01" -H "api-key:$KEY"` → 200 | ❌ Wave 0 |
| INF-09 | Binary quantization is configured | integration | Above response: `.vectorSearch.compressions[0].kind == "binaryQuantization"` | ❌ Wave 0 |
| INF-09 | Index is West Europe | integration | Azure service region check via `az search service show` | ❌ Wave 0 |
| ENT-01 | Notion Entities DB has all 13 fields | integration | `curl "https://api.notion.com/v1/databases/$ENTITIES_DB_ID" -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28"` → parse `.properties` object, assert 13 named properties exist with correct types | ❌ Wave 0 |
| ENT-02 | Notion Projects DB has full schema | integration | Same pattern as above | ❌ Wave 0 |
| MEM-01 | notion-indexer round-trips an edit | integration | Insert test row in Notion Entities DB → wait 6 min → assert `SELECT FROM entity_index WHERE notion_page_id = $ID` returns the row | ❌ Wave 0 |
| MEM-01 | archive-not-delete: Status=Archived flows; hard-delete is rejected | unit + integration | Unit: indexer logic test. Integration: manually archive a page → assert row updates with `status='Archived'`; manually delete (trash) a page → assert row is UNCHANGED (no destructive write) | ❌ Wave 0 |
| MEM-02 | Kevin Context page seeded and retrievable | integration | `curl .../pages/$KEVIN_CTX_ID` → non-empty content | ❌ Wave 0 |
| D-08 / D-09 | Second backfill run yields zero new rows | integration | Run backfill Lambda twice, 1h apart; assert second run's `rows_inserted` log field == 0 | ❌ Wave 0 |
| D-12 | Notification cap: 4th send in same Stockholm day is rejected | unit | Vitest test wired to DynamoDB Local; simulate 4 sends, assert 4th returns `{allowed: false, reason: 'cap-exceeded'}` | ❌ Wave 0 |
| D-13 | Quiet hours: sends between 20:00–08:00 Stockholm rejected | unit | Mock `Date.now()` to each of 20:30, 02:00, 07:30, 08:30 Stockholm; assert first three rejected, fourth allowed | ❌ Wave 0 |
| D-14 | VPS freeze: test run writes to Legacy Inbox | integration | `ssh kevin@98.91.6.66 "systemctl start kos-classify.service"` → wait 30s → `curl .../databases/$LEGACY_INBOX_ID/query` → assert new row with `[MIGRERAD]` prefix exists | ❌ Wave 0 |
| D-15 | Cost alarm threshold triggers | manual-only | AWS Budgets cannot be synthetically triggered without incurring cost. Manual verification: set a $0.01 test budget → wait 24h → confirm email received → delete test budget | ❌ Wave 0 |
| D-15 | SNS email subscription confirmed (no PendingConfirmation) | integration | `aws sns list-subscriptions-by-topic --topic-arn $ARN --query 'Subscriptions[?SubscriptionArn==\`PendingConfirmation\`]' --output text` → expect empty | ❌ Wave 0 |
| Gate 1 master | End-to-end gate check | integration | `bash scripts/verify-gate-1.sh` runs all of the above in sequence; exits 0 only if all pass | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run test:unit` (Vitest unit-only, ~5 seconds)
- **Per wave merge:** `npm run test` + `npx cdk diff` (full suite + CDK diff against current prod)
- **Phase gate:** `bash scripts/verify-gate-1.sh` (all integration tests against live eu-north-1 / Azure / Notion / VPS) GREEN before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `vitest.config.ts` + `vitest.unit.config.ts` — base test config
- [ ] `packages/db/schema.test.ts` — asserts `owner_id` on every table
- [ ] `services/notification-cap-enforcer/src/cap.test.ts` — DynamoDB Local integration test (cap + quiet hours)
- [ ] `services/notion-indexer/src/indexer.test.ts` — mocked `@notionhq/client`, asserts overlap + idempotent upsert logic
- [ ] `scripts/verify-gate-1.sh` — master gate-check shell script running all 16 integration assertions
- [ ] `scripts/verify-stacks-exist.sh` — CloudFormation + resource existence checks
- [ ] `scripts/seed-secrets.sh` — interactive secret seeding (prompts for Notion token, Azure key, etc.)
- [ ] `scripts/deploy-vps-freeze.sh` — rsync patched scripts + restart systemd units
- [ ] `scripts/backfill-notion.sh` — invokes backfill Lambda, streams logs
- [ ] `cdk/test/stacks.test.ts` — Vitest CDK snapshot tests (one per stack)
- [ ] Framework install: `npm install -D vitest @types/node pg ts-node`
- [ ] DynamoDB Local setup (docker-compose.yml) for offline cap tests
- [ ] Postgres test container (docker-compose.yml) for migration tests

## Security Domain

> Required per default (no explicit `security_enforcement: false`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (forward-compat) | Static Bearer token in Secrets Manager; no login UI in Phase 1 |
| V3 Session Management | no | No sessions in Phase 1 (no dashboard yet) |
| V4 Access Control | yes | IAM least-privilege per Lambda; bucket policy scoped to VPC endpoint; RDS via security group only |
| V5 Input Validation | yes | `zod` schemas on Notion webhook payloads (Phase 1 has no webhooks but schema infra is set) and EventBridge event Detail shapes |
| V6 Cryptography | yes | RDS encrypted at rest (KMS-managed); S3 SSE-S3 (or KMS); Secrets Manager KMS-managed; TLS 1.2+ enforced via `rds.force_ssl=1` parameter |
| V7 Error Handling | yes | CloudWatch structured logs; no secret leakage in error messages (review Lambda catch blocks); DLQ retention 14 days |
| V8 Data Protection | yes | All EU data in eu-north-1 + West Europe; Notion EU residency flagged as Open Question |
| V9 Communication | yes | All inter-service TLS; `aws:SecureTransport: true` bucket policy condition |
| V12 File/Resource | partial | S3 upload size limit not yet configured (Phase 2 capture concern); Phase 1 sets bucket encryption + versioning |
| V14 Configuration | yes | CDK IaC (auditable), RETAIN removal policy, deletion protection on RDS |

### Known Threat Patterns for KOS Phase 1

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Notion token exfiltration via Lambda env var leak | Information Disclosure | Store in Secrets Manager, fetch at runtime via SDK; never log secret values; CloudWatch logs scrubbed at line-level (CDK log group filter) |
| Unauthenticated public S3 access | Information Disclosure | `BlockPublicAccess.BLOCK_ALL` + bucket policy denying all requests except from VPC endpoint |
| RDS exposed to internet | Tampering | Private isolated subnet, no public endpoint, SG ingress only from Lambda SG |
| CDK deploy with leaked credentials | Elevation of Privilege | No AWS credentials in repo; CDK uses ambient IAM user creds; `.gitignore` covers `cdk.out/`, `.env` |
| DynamoDB cap table misused | Tampering (bypass) | `ConditionExpression` + IAM deny on direct writes from anything except the notification-cap-enforcer function |
| Secrets Manager secret rotation missed | Credential compromise | Annual rotation reminder in STATE.md (Phase 1 accepts manual; automated rotation Lambda is v2) |
| Notion hard-delete of tracked page | Integrity | Indexer treats 404 on retrieve as log-only (archive-not-delete per D-09); Postgres row is never deleted |
| VPS SSH key compromise | Elevation of Privilege | Out of scope for KOS codebase; Kevin's responsibility; mitigated by VPS decommission in Phase 10 |
| EventBridge bus unauthorized publish | Tampering | Bus resource policy restricts PutEvents to specific IAM principals (the capture Lambdas); default deny |
| Cost-alarm email spoofing | Spoofing | SNS email subscription goes via AWS-signed infrastructure; Kevin whitelists AWS confirmation sender |

## Sources

### Primary (HIGH confidence)

- [AWS CDK v2 NodejsFunction documentation](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_nodejs-readme.html) — esbuild bundling, externalModules, Docker fallback
- [AWS CDK v2 NodejsFunction BundlingOptions](https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_lambda_nodejs/BundlingOptions.html) — minify, sourceMap, treeShaking, target, externalModules, define
- [AWS RDS for PostgreSQL supports pgvector 0.8.0](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/) — PostgreSQL 16.5+ support confirmed
- [Aurora Serverless v2 pgvector HNSW issue — AWS re:Post](https://repost.aws/questions/QUCjnj-8NNTne60CKtmh7b4w/aurora-serverless-v2-pgvector-hsnw-index-not-used) — confirms provisioned RDS is safe
- [Drizzle ORM pgvector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search) — built-in `vector()` type in 0.31+
- [Azure AI Search: Compress vectors using quantization](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-quantization) — REST API 2025-09-01 binary quantization config
- [Azure AI Search: Index binary vectors](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-index-binary-data) — rescoreStorageMethod options
- [Azure AI Search cost reduction 92.5%](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-ai-search-cut-vector-costs-up-to-92-5-with-new-compression-techniques/4404866) — Microsoft-published benchmark
- [Notion data residency](https://www.notion.com/help/data-residency) — EU residency is Enterprise-plan-only
- [Notion API rate limits](https://developers.notion.com/reference/request-limits) — 3 req/s per integration
- [Notion API query-a-data-source](https://developers.notion.com/reference/query-a-data-source) — filter by last_edited_time, pagination
- [AWS EventBridge Scheduler schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html) — IANA timezone support, DST handling
- [AWS CDK Construct Library for EventBridge Scheduler GA April 2025](https://aws.amazon.com/about-aws/whats-new/2025/04/aws-cdk-construct-library-eventbridge-scheduler/)
- [S3 Gateway Endpoint — AWS VPC docs](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html) — $0 cost, route-table auto-update
- [S3 access via VPC endpoints — AWS blog](https://aws.amazon.com/blogs/storage/managing-amazon-s3-access-with-vpc-endpoints-and-s3-access-points/) — `aws:SourceVpce` condition, NOT `aws:SourceIp`
- [AWS Budgets best practices](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html) — current AWS recommendation over CloudWatch billing alarms
- [AWS CloudWatch billing alarms — us-east-1 only constraint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_billing.html)
- [AWS Transcribe CreateVocabulary API](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_CreateVocabulary.html) — sv-SE supported
- [AWS Transcribe: custom vocabulary using list (phrase format)](https://docs.aws.amazon.com/transcribe/latest/dg/custom-vocabulary-create-list.html)
- [AWS Transcribe supported languages](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html) — language ID does NOT support Swedish
- [AWS SNS EmailSubscription CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_sns_subscriptions.EmailSubscription.html) — manual confirmation required
- [Intl.DateTimeFormat timezone MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) — toLocaleString('sv-SE') semantics

### Secondary (MEDIUM confidence)

- [Custom vocabulary in Swedish — AWS re:Post](https://repost.aws/questions/QU_Aa3ot97TP-jYE-pQDCCzg/custom-vocabulary-in-swedish-amazon-transcribe) — CLM not available; IPA/SoundsLike deprecation signal
- [DynamoDB rate-limit pattern via node-rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible/wiki/DynamoDB) — ADD + ConditionExpression pattern verified
- [Aurora Serverless v2 production deep dive, andrewbaker.ninja](https://andrewbaker.ninja/2026/02/21/scaling-aurora-serverless-v2-postgresql-a-production-deep-dive/) — cost comparison RDS vs Aurora
- [AWS decision guide Fargate vs Lambda](https://docs.aws.amazon.com/decision-guides/latest/fargate-or-lambda/fargate-or-lambda.html) — official AWS guidance

### Tertiary (LOW confidence, flagged for validation)

- Drizzle ORM minor-version pin at 0.31+ — VERIFY `npm view drizzle-orm version` in Wave 0
- `@azure/search-documents` SDK version supporting `2025-09-01` API — VERIFY `npm view` in Wave 0
- VPS systemd unit names (`kos-classify.service`, etc.) — VERIFY via SSH in Wave 0
- AWS Transcribe sv-SE batch in eu-north-1 — VERIFY via CLI in Wave 0 (see Open Question 1)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all major deps verified against official docs
- Architecture (5-stack CDK split, 7 patterns): HIGH — matches CONTEXT.md locked decisions + AWS CDK v2 idioms
- Pitfalls: HIGH — each rooted in a specific AWS/Notion/Drizzle gotcha with citation
- Azure AI Search binary quantization payload: MEDIUM-HIGH — payload structure verified against Microsoft docs; field-level dimensions/algorithm params are best-practice defaults (tunable)
- AWS Transcribe Swedish vocabulary format: MEDIUM — IPA/SoundsLike deprecation noted but not definitively confirmed; phrase-list format is safe path
- Validation Architecture: HIGH — every Gate 1 criterion has a CLI-executable verification

**Research date:** 2026-04-22
**Valid until:** 2026-05-22 (30 days — stable stack, slow-moving infra components)

## RESEARCH COMPLETE

**Phase:** 01 - Infrastructure Foundation
**Confidence:** HIGH

### Key Findings

- **Drizzle 0.31+ has built-in `vector()` — no customType boilerplate.** Update STACK.md version pin from 0.30+ to 0.31+.
- **AWS Budgets (not CloudWatch billing alarms) for cost thresholds.** CloudWatch billing metrics are us-east-1-only; a eu-north-1 CDK stack using them requires cross-region contortion. Budgets is AWS-recommended, multi-region, and has native SNS action support.
- **Azure AI Search binary quantization is index-creation-time configuration; retrofit = full re-index.** Ship the correct vectorSearch.compressions[] payload on first POST to `/indexes?api-version=2025-09-01`.
- **SNS email subscriptions require manual Kevin-clicks-link confirmation.** CDK cannot auto-confirm. Plan must include post-deploy verification: `aws sns list-subscriptions-by-topic` filters for `PendingConfirmation`.
- **AWS Transcribe SoundsLike/IPA columns appear deprecated for Swedish.** Use phrase-only format with hyphenated compounds. Not blocking for Phase 1 (vocab content deferred per CONTEXT.md).
- **EventBridge Scheduler (not Schedule rule) for any cron work — it supports `ScheduleExpressionTimezone: 'Europe/Stockholm'` with native DST handling.** Apply to notion-indexer 5-min poll even though "every 5 min" is DST-agnostic — consistency of tooling matters.
- **Stockholm locale `toLocaleString('sv-SE', {timeZone: 'Europe/Stockholm'})` emits deterministic `YYYY-MM-DD HH:MM:SS`** — safe substrate for DynamoDB cap key and quiet-hours check. Zero external time-zone library needed.
- **S3 Gateway Endpoint bucket policy MUST use `aws:SourceVpce`, never `aws:SourceIp`** — Gateway Endpoint traffic has no internet source IP.
- **pgvector 0.8.0 requires RDS PostgreSQL 16.5 or higher** — pin `PostgresEngineVersion.VER_16_5` in CDK.
- **One high-risk assumption (A9):** AWS Transcribe sv-SE in eu-north-1 needs Wave 0 CLI verification. Fallback is eu-west-1 (Ireland) with ~30ms cross-region hop, Phase 2 concern only.

### File Created

`.planning/phases/01-infrastructure-foundation/01-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Versions verifiable via npm; all major libraries on current stable |
| Architecture (5-stack CDK, 7 patterns) | HIGH | Matches CONTEXT.md decisions + AWS CDK v2 idioms |
| Pitfalls | HIGH | Each grounded in specific AWS/Notion/Drizzle citation |
| Azure AI Search payload shape | MEDIUM-HIGH | Official Microsoft docs confirm structure; dims/m/efConstruction are tunable defaults |
| AWS Transcribe Swedish vocabulary | MEDIUM | Phrase format safe; IPA/SoundsLike deprecation for Swedish is inferred from multiple signals, not a single definitive source |
| Validation Architecture | HIGH | Every Gate 1 criterion has a CLI-executable check |

### Open Questions (must land in STATE.md / plan)

1. AWS Transcribe sv-SE in eu-north-1 availability — Wave 0 verification (one `aws` CLI call)
2. Bedrock Sonnet 4.6 / Haiku 4.5 in eu-north-1 vs CRIS — NOT blocking Phase 1; flag for Phase 2
3. Notion workspace plan tier — Enterprise required for EU residency; single Kevin-confirmation task
4. Exact VPS systemd unit names / script file layout — Wave 0 SSH verification before VPS freeze deploy
5. Secrets Manager placeholder vs real-value seed flow — `scripts/seed-secrets.sh` Wave 0

### Ready for Planning

Research complete. Planner can now decompose Phase 1 into plans covering: (a) CDK monorepo bootstrap + NetworkStack, (b) DataStack (RDS + S3 + Secrets), (c) EventsStack (5 buses + DLQs), (d) IntegrationsStack (notion-indexer + Transcribe vocab + Azure AI Search bootstrap), (e) SafetyStack (notification-cap + Budgets + VPS freeze), (f) packages/db schema + migrations, (g) Wave 0 testing infrastructure, (h) Gate 1 verification script. Each plan has concrete locked decisions, testable outcomes, and cited reference patterns.
