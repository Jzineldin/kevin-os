/**
 * Kevin Context block loader — lifted from services/triage/src/persist.ts
 * (now canonical here; Phase 6 Plan 06-05 removes duplications from
 * triage/voice-capture/entity-resolver).
 *
 * Reads the 6-section Kevin Context page rows from `kevin_context` Postgres
 * table (populated by notion-indexer from the Notion "Kevin Context" page).
 */
import type { Pool as PgPool } from 'pg';
import type { KevinContextBlock } from '@kos/contracts/context';

// Logical section keys (returned in KevinContextBlock).
const EXPECTED_SECTIONS = [
  'current_priorities',
  'active_deals',
  'whos_who',
  'blocked_on',
  'recent_decisions',
  'open_questions',
] as const;

// Map logical section keys → Notion `section_heading` values populated by
// notion-indexer for the Kevin Context page (`kevin_context.section_heading`).
// Keys above match the KevinContextBlock contract; values match Kevin's actual
// Notion section headings. CR-01: SQL filters on section_heading (the actual
// schema column — see packages/db/src/schema.ts:183), not the legacy logical
// key.
const SECTION_HEADINGS_BY_KEY: Record<(typeof EXPECTED_SECTIONS)[number], string> = {
  current_priorities: 'Current priorities',
  active_deals: 'Active deals',
  whos_who: "Who's who",
  blocked_on: 'Blocked on',
  recent_decisions: 'Recent decisions',
  open_questions: 'Open questions',
};
const EXPECTED_SECTION_HEADINGS = Object.values(SECTION_HEADINGS_BY_KEY);

export interface LoadKevinContextOptions {
  pool: PgPool;
  ownerId: string;
}

/**
 * Load the 6-section Kevin Context block for the given owner.
 *
 * Returns an empty-ish block if no rows exist (cold start / pre-indexer);
 * callers should treat this as "no Kevin Context available" rather than an
 * error — Phase 1's notion-indexer populates on its 5-min cycle.
 */
export async function loadKevinContextBlock(
  opts: LoadKevinContextOptions,
): Promise<KevinContextBlock> {
  const { pool, ownerId } = opts;

  const { rows } = await pool.query<{
    section_heading: string;
    section_body: string;
    updated_at: Date;
  }>(
    `SELECT section_heading, section_body, updated_at
       FROM kevin_context
      WHERE owner_id = $1
        AND section_heading = ANY($2::text[])`,
    [ownerId, EXPECTED_SECTION_HEADINGS],
  );

  const byHeading = new Map(rows.map((r) => [r.section_heading, r]));
  const lastUpdated = rows
    .map((r) => r.updated_at)
    .reduce<Date | null>((acc, cur) => (acc && acc > cur ? acc : cur), null);

  const lookup = (key: (typeof EXPECTED_SECTIONS)[number]): string =>
    byHeading.get(SECTION_HEADINGS_BY_KEY[key])?.section_body ?? '';

  return {
    current_priorities: lookup('current_priorities'),
    active_deals: lookup('active_deals'),
    whos_who: lookup('whos_who'),
    blocked_on: lookup('blocked_on'),
    recent_decisions: lookup('recent_decisions'),
    open_questions: lookup('open_questions'),
    last_updated: lastUpdated ? lastUpdated.toISOString() : null,
  };
}

/**
 * Markdown-string variant — preserves the legacy Phase 2 contract (string
 * suitable for direct system-prompt injection). Used by the 4 consumer
 * Lambdas (triage / voice-capture / entity-resolver / transcript-extractor)
 * as a degraded fallback when the full `loadContext` path fails. Plan 06-05
 * canonicalises this here so each service no longer duplicates the SQL.
 *
 * Returns the section_heading + section_body shape used by Phase 2's
 * `kevin_context` table layout (which differs from the section-keyed
 * `kevin_context` shape consumed by `loadKevinContextBlock`). The handlers
 * that previously called `loadKevinContextBlock(ownerId): Promise<string>`
 * keep that exact API surface.
 */
export async function loadKevinContextMarkdown(
  ownerId: string,
  pool: PgPool,
): Promise<string> {
  const { rows } = await pool.query<{ section_heading: string; section_body: string }>(
    `SELECT section_heading, section_body
       FROM kevin_context
       WHERE owner_id = $1
       ORDER BY section_heading`,
    [ownerId],
  );
  return rows
    .map((r) => `## ${r.section_heading}\n${r.section_body}`)
    .join('\n\n');
}
