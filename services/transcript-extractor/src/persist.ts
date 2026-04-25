/**
 * transcript-extractor persist — Postgres + EventBridge writes.
 *
 * Mirrors services/triage/src/persist.ts (RDS Proxy IAM-auth pool +
 * agent_runs idempotency helpers per D-21). Agent-specific writers live
 * here:
 *   - writeMentionEvents — bulk INSERT into mention_events using the
 *     ACTUAL Phase 2 schema columns (owner_id, capture_id, source,
 *     context, occurred_at). The Wave 0 stub used non-existent columns
 *     (kind / excerpt / metadata) — Rule 1 bug fixed.
 *   - writeTranscriptIndexed — audit row in agent_runs with
 *     agent_name='transcript-indexed' so Plan 06-03's
 *     azure-search-indexer-transcripts can use it as a delta cursor source.
 *   - publishMentionsDetected — PutEvents loop, each entry validated by
 *     EntityMentionDetectedSchema (existing Phase 2 contract). Each emit
 *     uses a fresh ULID for capture_id (the schema's ULID regex would
 *     reject the Notion page UUID).
 *
 * The Notion Command Center writer lives in services/transcript-extractor/
 * src/notion.ts (D-07).
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-02-PLAN.md
 *            .planning/phases/06-granola-semantic-memory/06-CONTEXT.md
 *            (D-05/D-06/D-07/D-08, D-21, D-28).
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { ulid } from 'ulid';
import {
  EntityMentionDetectedSchema,
  type EntityMentionDetected,
} from '@kos/contracts/events';
import type {
  TranscriptAvailable,
  TranscriptExtraction,
} from '@kos/contracts/context';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;
let eb: EventBridgeClient | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER;
  if (!host) throw new Error('RDS_PROXY_ENDPOINT not set');
  if (!user) throw new Error('RDS_IAM_USER not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const signer = new Signer({ hostname: host, port: 5432, region, username: user });
  pool = new Pool({
    host,
    port: 5432,
    user,
    database: process.env.DATABASE_NAME ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

function getEventBridge(): EventBridgeClient {
  if (!eb) eb = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return eb;
}

// ---------------------------------------------------------------------------
// agent_runs idempotency (D-21) — mirrors services/triage/src/persist.ts.
// ---------------------------------------------------------------------------

export type AgentRunStatus = 'started' | 'ok' | 'error';

export async function findPriorOkRun(
  captureId: string,
  agentName: string,
  ownerId: string,
): Promise<boolean> {
  const p = await getPool();
  const r = await p.query(
    `SELECT 1 FROM agent_runs
       WHERE owner_id = $1 AND capture_id = $2 AND agent_name = $3 AND status = 'ok'
       LIMIT 1`,
    [ownerId, captureId, agentName],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface InsertAgentRunInput {
  ownerId: string;
  captureId: string;
  agentName: string;
  status: AgentRunStatus;
}

export async function insertAgentRun(row: InsertAgentRunInput): Promise<string> {
  const p = await getPool();
  const r = await p.query(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [row.ownerId, row.captureId, row.agentName, row.status],
  );
  return r.rows[0].id as string;
}

export interface UpdateAgentRunPatch {
  status: AgentRunStatus;
  outputJson?: unknown;
  tokensInput?: number;
  tokensOutput?: number;
  errorMessage?: string;
}

export async function updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<void> {
  const p = await getPool();
  await p.query(
    `UPDATE agent_runs
        SET status = $2,
            output_json = $3,
            tokens_input = $4,
            tokens_output = $5,
            error_message = $6,
            finished_at = NOW()
      WHERE id = $1`,
    [
      id,
      patch.status,
      patch.outputJson ?? null,
      patch.tokensInput ?? null,
      patch.tokensOutput ?? null,
      patch.errorMessage ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Kevin Context loader — Phase 6 Plan 06-05 canonicalised in
// `@kos/context-loader::loadKevinContextMarkdown`. The Wave-2 placeholder
// `loadKevinContextBlockOnce` was retired; the new path goes through the
// full `loadContext` library (handler.ts), with this thin adapter as the
// degraded fallback when the full path fails.
// ---------------------------------------------------------------------------

export async function loadKevinContextBlockOnce(ownerId: string): Promise<string> {
  const { loadKevinContextMarkdown } = await import('@kos/context-loader');
  const p = await getPool();
  return loadKevinContextMarkdown(ownerId, p);
}

// ---------------------------------------------------------------------------
// mention_events bulk insert — uses the ACTUAL Phase 2 schema columns
// (owner_id, capture_id, source, context, occurred_at). entity_id stays
// NULL here; the resolver downstream attaches canonical entity_ids when it
// consumes entity.mention.detected.
// ---------------------------------------------------------------------------

export interface WriteMentionEventsInput {
  pool: PgPool;
  detail: TranscriptAvailable;
  mentions: TranscriptExtraction['mentioned_entities'];
}

export async function writeMentionEvents(input: WriteMentionEventsInput): Promise<number> {
  const { pool: p, detail, mentions } = input;
  if (mentions.length === 0) return 0;

  const args: unknown[] = [];
  const placeholders: string[] = [];
  const occurredAt = new Date(); // single timestamp for the whole batch
  mentions.forEach((m, i) => {
    const base = i * 5;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::timestamptz)`,
    );
    args.push(
      detail.owner_id,
      detail.capture_id,
      'granola-transcript',
      `${m.name}: ${m.excerpt.slice(0, 480)}`.slice(0, 1000),
      occurredAt,
    );
  });

  await p.query(
    `INSERT INTO mention_events (owner_id, capture_id, source, context, occurred_at)
       VALUES ${placeholders.join(', ')}`,
    args,
  );
  return mentions.length;
}

// ---------------------------------------------------------------------------
// transcripts_indexed audit — Plan 06-02 calls for a per-transcript audit
// row consumed by Plan 06-03 azure-search-indexer-transcripts. Plan 06-00
// SUMMARY recorded that no separate transcripts_indexed table was created
// (the consumer reads agent_runs instead). To honor the Plan 06-02 contract
// while staying compatible with the shipped 0012 migration, we write an
// extra agent_runs row with agent_name='transcript-indexed' and the
// summary/counts in output_json. The indexer reads it via
// `WHERE agent_name='transcript-indexed'`.
// ---------------------------------------------------------------------------

export interface WriteTranscriptIndexedInput {
  pool: PgPool;
  detail: TranscriptAvailable;
  extraction: TranscriptExtraction;
  recordedAt: Date;
}

export async function writeTranscriptIndexed(input: WriteTranscriptIndexedInput): Promise<void> {
  const { pool: p, detail, extraction, recordedAt } = input;
  // WR-06: no ON CONFLICT clause here. Idempotency is enforced upstream
  // by findPriorOkRun (handler.ts:126), which short-circuits before the
  // second write ever reaches this function. A target-less
  // `ON CONFLICT DO NOTHING` only guards against PK collisions on
  // agent_runs.id (uuid DEFAULT gen_random_uuid() — astronomically
  // improbable), so it contributed nothing but misleading semantics for
  // future readers. Adding a real unique index on
  // (owner_id, capture_id) WHERE agent_name='transcript-indexed' would
  // require a schema migration — out of scope for this fix; tracked in
  // backlog if we later see duplicate transcript-indexed rows.
  await p.query(
    `INSERT INTO agent_runs (owner_id, capture_id, agent_name, status, output_json, finished_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
    [
      detail.owner_id,
      detail.capture_id,
      'transcript-indexed',
      'ok',
      JSON.stringify({
        transcript_id: detail.transcript_id,
        notion_page_id: detail.notion_page_id,
        title: detail.title,
        summary: extraction.summary,
        action_items_count: extraction.action_items.length,
        mentions_count: extraction.mentioned_entities.length,
        recorded_at: recordedAt.toISOString(),
        source: 'granola',
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// PutEvents emitter — entity.mention.detected per extracted mention.
// Each emit uses a fresh ULID for capture_id (existing Phase 2 schema
// requires ULID regex; the transcript_id is a Notion page UUID). The
// originating transcript_id is preserved in context_snippet so downstream
// observers can correlate.
// ---------------------------------------------------------------------------

// Map our 5-value LLM type → entity-resolver's 4-value candidate_type.
// 'Document' → 'Other'; 'Unknown' → 'Other'. The resolver re-classifies
// via Sonnet 4.6 disambig downstream anyway.
function mapCandidateType(
  t: TranscriptExtraction['mentioned_entities'][number]['type'],
): EntityMentionDetected['candidate_type'] {
  switch (t) {
    case 'Person':
      return 'Person';
    case 'Project':
      return 'Project';
    case 'Company':
      return 'Org';
    case 'Document':
    case 'Unknown':
    default:
      return 'Other';
  }
}

export interface PublishMentionsInput {
  detail: TranscriptAvailable;
  mentions: TranscriptExtraction['mentioned_entities'];
  /** Optional Command Center page id to attach for cross-agent traceability. */
  commandCenterPageId?: string;
}

export async function publishMentionsDetected(input: PublishMentionsInput): Promise<number> {
  const { detail, mentions, commandCenterPageId } = input;
  if (mentions.length === 0) return 0;

  const occurredAt = new Date().toISOString();
  const entries = mentions.map((m) => {
    const validated = EntityMentionDetectedSchema.parse({
      // Per-mention ULID (not the Notion page UUID) so the existing Phase 2
      // ULID-regex validation in EntityMentionDetectedSchema passes. The
      // originating transcript is referenced in context_snippet.
      capture_id: ulid(),
      mention_text: m.name.slice(0, 200),
      context_snippet: `[transcript=${detail.transcript_id}] ${m.excerpt}`.slice(0, 500),
      candidate_type: mapCandidateType(m.type),
      source: 'granola-transcript',
      occurred_at: occurredAt,
      ...(commandCenterPageId
        ? { notion_command_center_page_id: commandCenterPageId }
        : {}),
    });
    return {
      EventBusName: process.env.KOS_AGENT_BUS_NAME ?? 'kos.agent',
      Source: 'kos.agent',
      DetailType: 'entity.mention.detected',
      Detail: JSON.stringify(validated),
    };
  });

  // EventBridge PutEvents accepts up to 10 entries per call.
  const ebClient = getEventBridge();
  for (let i = 0; i < entries.length; i += 10) {
    await ebClient.send(new PutEventsCommand({ Entries: entries.slice(i, i + 10) }));
  }
  return entries.length;
}

/** Test-only helper — reset module-scope caches between vitest cases. */
export function __resetForTests(): void {
  pool = null;
  eb = null;
}
