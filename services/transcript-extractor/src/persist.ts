/**
 * Persistence layer for transcript-extractor — Postgres + Notion.
 *
 * Writes:
 *  - Command Center rows (Kevin's Swedish schema: Uppgift/Typ/Prioritet/Anteckningar)
 *  - mention_events rows (one per mentioned entity; auto-fires trigger)
 *  - agent_runs row (for dashboard timeline + debugging)
 *
 * NOTE: entity resolution happens downstream in the entity-resolver Lambda
 * (consumes entity.mention.detected). This service writes mention_events
 * against a placeholder entity_id (the mentioned name hash) ONLY for
 * display/audit purposes; the resolver reconciles to canonical entity_ids.
 */
import type { Pool as PgPool } from 'pg';
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { Client as NotionClient } from '@notionhq/client';
import type { TranscriptAvailable, TranscriptExtraction } from '@kos/contracts/context';
import { createHash } from 'node:crypto';

let pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const host = process.env.DATABASE_HOST;
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const database = process.env.DATABASE_NAME ?? 'kos';
  const user = process.env.DATABASE_USER ?? 'kos_agent_writer';
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  if (!host) throw new Error('DATABASE_HOST env var not set');
  const signer = new Signer({ hostname: host, port, username: user, region });
  pool = new Pool({
    host,
    port,
    database,
    user,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    password: async () => signer.getAuthToken(),
  });
  return pool;
}

// ---------------------------------------------------------------------------
// Command Center writes (Kevin's Swedish schema)
// ---------------------------------------------------------------------------

const TYP_OPTIONS: Record<TranscriptExtraction['action_items'][number]['priority'], string> = {
  high: '🔴 Akut',
  medium: '🟡 Viktigt',
  low: '⚪ Bakgrund',
};

const PRIO_OPTIONS: Record<TranscriptExtraction['action_items'][number]['priority'], string> = {
  high: 'Hög',
  medium: 'Medel',
  low: 'Låg',
};

export async function writeActionItems(args: {
  notion: NotionClient;
  detail: TranscriptAvailable;
  extraction: TranscriptExtraction;
}): Promise<string[]> {
  const { notion, detail, extraction } = args;
  const dbId = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!dbId) throw new Error('NOTION_COMMAND_CENTER_DB_ID env var not set');

  const createdIds: string[] = [];
  for (const item of extraction.action_items) {
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        Uppgift: { title: [{ text: { content: item.title.slice(0, 200) } }] },
        Typ: { select: { name: TYP_OPTIONS[item.priority] ?? TYP_OPTIONS.medium } },
        Prioritet: { select: { name: PRIO_OPTIONS[item.priority] ?? PRIO_OPTIONS.medium } },
        Anteckningar: {
          rich_text: [
            {
              text: {
                content: [
                  `Källa: Granola-transkript (${detail.title ?? 'untitled'})`,
                  item.due_hint ? `Deadline-hint: ${item.due_hint}` : null,
                  `Excerpt: "${item.source_excerpt.slice(0, 400)}"`,
                  `capture_id: ${detail.capture_id}`,
                ]
                  .filter(Boolean)
                  .join('\n\n')
                  .slice(0, 2000),
              },
            },
          ],
        },
      },
    });
    createdIds.push(page.id);
  }
  return createdIds;
}

// ---------------------------------------------------------------------------
// mention_events writes
// ---------------------------------------------------------------------------

export async function writeMentionEvents(args: {
  pool: PgPool;
  detail: TranscriptAvailable;
  extraction: TranscriptExtraction;
}): Promise<number> {
  const { pool, detail, extraction } = args;
  if (extraction.mentioned_entities.length === 0) return 0;

  // Bulk insert — placeholder entity_id (name hash) for rows; resolver
  // reconciles to canonical entity_id downstream.
  const values = extraction.mentioned_entities.map((m) => ({
    capture_id: detail.capture_id,
    owner_id: detail.owner_id,
    entity_id: nameToPlaceholderUuid(m.name, detail.owner_id),
    kind: 'transcript_mention',
    occurred_at: new Date(),
    excerpt: m.excerpt.slice(0, 1000),
    metadata: JSON.stringify({
      resolver_pending: true,
      name: m.name,
      type: m.type,
      aliases: m.aliases,
      sentiment: m.sentiment,
      occurrence_count: m.occurrence_count,
      source_transcript_id: detail.transcript_id,
    }),
  }));

  const args_array = values.flatMap((v) => [
    v.capture_id,
    v.owner_id,
    v.entity_id,
    v.kind,
    v.occurred_at,
    v.excerpt,
    v.metadata,
  ]);
  const placeholders = values
    .map((_, i) => {
      const base = i * 7;
      return `($${base + 1}, $${base + 2}, $${base + 3}::uuid, $${base + 4}, $${base + 5}::timestamptz, $${base + 6}, $${base + 7}::jsonb)`;
    })
    .join(', ');

  await pool.query(
    `INSERT INTO mention_events
           (capture_id, owner_id, entity_id, kind, occurred_at, excerpt, metadata)
      VALUES ${placeholders}
     ON CONFLICT DO NOTHING`,
    args_array,
  );

  return values.length;
}

/**
 * Deterministic UUID-shaped placeholder for mention_events rows where the
 * canonical entity_id hasn't been resolved yet. UUID v5 namespace-based
 * so repeat mentions of the same name hash to the same placeholder — the
 * resolver can locate + re-key later.
 */
function nameToPlaceholderUuid(name: string, ownerId: string): string {
  const h = createHash('sha1').update(`${ownerId}|${name.toLowerCase().trim()}`).digest('hex');
  // Format as UUID v5-ish (not strictly RFC-compliant, but uuid-column-valid).
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// agent_runs write
// ---------------------------------------------------------------------------

export async function writeAgentRun(args: {
  pool: PgPool;
  detail: TranscriptAvailable;
  extraction: TranscriptExtraction;
  elapsedMs: number;
  dossierElapsedMs: number;
}): Promise<void> {
  const { pool, detail, extraction, elapsedMs, dossierElapsedMs } = args;
  await pool.query(
    `INSERT INTO agent_runs (capture_id, owner_id, agent_name, status, elapsed_ms, context)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (capture_id, agent_name) DO NOTHING`,
    [
      detail.capture_id,
      detail.owner_id,
      'transcript-extractor',
      'ok',
      elapsedMs,
      JSON.stringify({
        transcript_id: detail.transcript_id,
        notion_page_id: detail.notion_page_id,
        title: detail.title,
        action_items: extraction.action_items.length,
        mentions: extraction.mentioned_entities.length,
        summary: extraction.summary.slice(0, 400),
        decisions: extraction.decisions,
        open_questions: extraction.open_questions,
        dossier_elapsed_ms: dossierElapsedMs,
      }),
    ],
  );
}
