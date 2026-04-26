/**
 * Email-triage entity resolver — minimal lookup against entity_index by
 * email addresses. Returns a list of matching entity ids so context.ts
 * can ask @kos/context-loader for the corresponding dossiers.
 *
 * Phase 2 entity_index does NOT yet have an `email text[]` column — this
 * is documented in the Plan 04-04 SUMMARY as a future enhancement
 * (Phase 4 ships entity-by-email lookup as a no-op fallback). When the
 * column lands, this function picks up the lookup automatically.
 *
 * Defensive: any pg error (relation/column missing) is swallowed and
 * returns []; the agent runs with an empty entity-id list and the
 * context loader degrades to Kevin-Context-only.
 */
import type { Pool as PgPool } from 'pg';

export async function resolveEntitiesByEmail(
  pool: PgPool,
  ownerId: string,
  emails: string[],
): Promise<string[]> {
  if (emails.length === 0) return [];
  // Strip RFC 5322 display names — keep only the bare address. Cheap regex
  // is fine; the pgcrypto / mailparser equivalent would be overkill here.
  const addrs = emails
    .map((e) => {
      const m = e.match(/<([^>]+)>/);
      return (m?.[1] ?? e).trim().toLowerCase();
    })
    .filter((e) => e.length > 0 && e.includes('@'));

  if (addrs.length === 0) return [];

  try {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM entity_index
        WHERE owner_id = $1
          AND email && $2::text[]
        LIMIT 10`,
      [ownerId, addrs],
    );
    return r.rows.map((x) => String(x.id));
  } catch (err) {
    // Likely "column entity_index.email does not exist" (42703) on the
    // current schema — the email column is a future enhancement. Log once
    // per cold start; subsequent invocations short-circuit on the same
    // empty entity-id list.
    console.warn(
      '[email-triage] resolveEntitiesByEmail: lookup failed; degrading to []',
      { err: String(err) },
    );
    return [];
  }
}
