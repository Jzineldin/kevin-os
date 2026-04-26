/**
 * gmail-poller persist layer (idempotency check before emitting).
 *
 * Mirrors services/calendar-reader/src/persist.ts for the RDS Proxy IAM
 * connection pattern. Provides one read query: "have we already started
 * processing this Gmail message_id for this account?"
 *
 * The downstream `email_drafts` table has UNIQUE(account_id, message_id)
 * which is the authoritative idempotency anchor (email-triage's INSERT
 * collapses duplicates). The pre-check here avoids redundant Bedrock
 * spend on rapid Lambda retries — without it, two concurrent poller
 * invocations would both emit capture.received, both classify with
 * Haiku/Sonnet, and only the second INSERT would no-op. With it, the
 * second poll sees the first's row and skips emission entirely.
 *
 * IAM: read-only `email_drafts` SELECT only — gmail-poller has NO write
 * to email_drafts (that's email-triage's job, scoped under its own role).
 */
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { GmailAccount } from './oauth.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const host = process.env.RDS_PROXY_ENDPOINT ?? process.env.DATABASE_HOST;
  const user =
    process.env.RDS_IAM_USER ?? process.env.DATABASE_USER ?? 'kos_agent_writer';
  if (!host) throw new Error('RDS_PROXY_ENDPOINT (or DATABASE_HOST) not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const port = Number(process.env.DATABASE_PORT ?? '5432');
  const signer = new Signer({ hostname: host, port, region, username: user });
  pool = new Pool({
    host,
    port,
    user,
    database: process.env.DATABASE_NAME ?? 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return pool;
}

export interface KnownMessagesArgs {
  ownerId: string;
  account: GmailAccount;
  messageIds: string[];
}

/**
 * Returns the subset of `messageIds` already present in `email_drafts`
 * for this (owner, account). Caller filters them out before emitting
 * capture.received so we don't queue redundant triage work.
 */
export async function findKnownMessages(
  pgPool: PgPool,
  args: KnownMessagesArgs,
): Promise<Set<string>> {
  if (args.messageIds.length === 0) return new Set();
  const { rows } = await pgPool.query<{ message_id: string }>(
    `SELECT message_id
       FROM email_drafts
      WHERE owner_id = $1
        AND account_id = $2
        AND message_id = ANY($3::text[])`,
    [args.ownerId, args.account, args.messageIds],
  );
  return new Set(rows.map((r) => r.message_id));
}

export function __resetForTests(): void {
  pool = null;
}
