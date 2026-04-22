import { uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Kevin's canonical owner UUID — valid RFC 4122 v4, hex-only.
 *
 * Single-user v1. Forward-compat per STATE.md Locked Decision #13:
 * every KOS table carries `owner_id` so multi-user is a trivial migration
 * (backfill a users table, drop the default, enforce RLS). Zero cost today.
 *
 * Mirrors `OWNER_ID` in packages/cdk/lib/config/env.ts — both must stay in
 * sync. The SQL DEFAULT on this column uses the same literal so raw psql /
 * pg-client inserts that omit ownerId still materialise Kevin's UUID.
 */
export const KEVIN_OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

/**
 * Column helper applied to every KOS table.
 *
 * Belt-and-suspenders: code paths also pass KEVIN_OWNER_ID explicitly on
 * insert; the SQL DEFAULT is a safety net for raw SQL migrations, bootstrap
 * seed scripts, and psql-driven maintenance.
 */
export const ownerId = () =>
  uuid('owner_id').notNull().default(sql`'7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid`);
