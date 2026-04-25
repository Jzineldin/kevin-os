/**
 * Single-user owner-scope guard.
 *
 * Every SELECT / INSERT / UPDATE issued by the dashboard-api Lambda MUST
 * pass through `ownerScoped(table, ...extras)` so that no query can ever
 * leak across owner boundaries. Forward-compat per STATE.md Locked
 * Decision #13 (single-user v1, multi-user is a trivial migration).
 *
 * The canonical UUID lives in `@kos/db/owner.ts` as `KEVIN_OWNER_ID` —
 * we re-export it here as OWNER_ID so that:
 *   (a) `services/dashboard-api/src/owner-scoped.ts` is the ONE file
 *       any handler touches to assert ownership;
 *   (b) a single literal flows through: migrations 0001-0010
 *       (SQL DEFAULT), packages/db/src/owner.ts (Drizzle default),
 *       and this wrapper.
 *
 * NOTE: 03-02-PLAN specified '7a6b5c4d-0000-0000-0000-000000000001' but
 * the entire repo (migrations 0001-0010 + packages/db/src/owner.ts +
 * packages/cdk/lib/config/env.ts) pins Kevin's UUID to
 * '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'. Plan 01 Deviation #2 already
 * resolved this drift the same way. Using the canonical value keeps the
 * chain consistent; introducing a second UUID here would break every
 * existing row on first run.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { KEVIN_OWNER_ID } from '@kos/db';

export const OWNER_ID = KEVIN_OWNER_ID;

type TableWithOwner = PgTable & { ownerId: PgColumn };

/**
 * Wraps a WHERE predicate with a mandatory `owner_id = OWNER_ID` guard.
 *
 * Usage:
 *   db.select().from(inboxIndex).where(ownerScoped(inboxIndex, eq(inboxIndex.status, 'pending')))
 *
 * Passing `extras` is optional — without it, returns just the owner
 * predicate so `.where(ownerScoped(table))` is valid.
 */
export function ownerScoped<T extends TableWithOwner>(table: T, extras?: SQL): SQL {
  const base = eq(table.ownerId, OWNER_ID);
  if (!extras) return base;
  return and(base, extras) as SQL;
}
