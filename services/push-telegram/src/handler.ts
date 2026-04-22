/**
 * push-telegram Lambda handler (Phase 1 scaffolding).
 *
 * Phase 1 scope:
 *  - Enforce DynamoDB notification cap (3/day) + Stockholm quiet hours
 *    (20:00-08:00) INLINE on every invocation (RESEARCH Anti-Pattern line 607).
 *  - On denial (quiet-hours or cap-exceeded), queue the message body into
 *    `telegram_inbox_queue` so the Phase 2 morning-brief drain can release
 *    suppressed items alongside the 08:00 brief.
 *  - On acceptance, log the stub send. Real Telegram API wiring lands in
 *    Phase 2 (CAP-01); Phase 1 exercises cap + quiet-hours via
 *    `scripts/verify-cap.mjs` without needing a real bot token.
 *
 * Wire contract:
 *  - Env: CAP_TABLE_NAME, RDS_SECRET_ARN, RDS_ENDPOINT (RDS Proxy),
 *         TELEGRAM_BOT_TOKEN_SECRET_ARN (not consumed in Phase 1).
 *  - Lambda lives OUTSIDE the VPC (D-05) — Telegram API is public; the
 *    RDS Proxy endpoint accepts IAM-auth connections from the public
 *    internet (see DataStack Proxy config).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { telegramInboxQueue } from '@kos/db';
import { enforceAndIncrement, type CapDenialReason } from './cap.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface PushTelegramEvent {
  body: string;
}

export interface PushTelegramResult {
  sent: boolean;
  queued: boolean;
  reason?: CapDenialReason;
}

// --- Module-scope caches (survive warm-start invocations) --------------------
let pool: PgPool | null = null;

async function getPool(): Promise<PgPool> {
  if (pool) return pool;
  const secretArn = process.env.RDS_SECRET_ARN;
  const host = process.env.RDS_ENDPOINT;
  if (!secretArn || !host) {
    throw new Error('RDS_SECRET_ARN and RDS_ENDPOINT must be set');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!secret.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }
  const creds = JSON.parse(secret.SecretString) as { username: string; password: string };
  pool = new Pool({
    host,
    port: 5432,
    user: creds.username,
    password: creds.password,
    database: 'kos',
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  return pool;
}

export async function handler(event: PushTelegramEvent): Promise<PushTelegramResult> {
  const capTableName = process.env.CAP_TABLE_NAME;
  if (!capTableName) {
    throw new Error('CAP_TABLE_NAME must be set');
  }

  const check = await enforceAndIncrement({ tableName: capTableName });

  if (!check.allowed) {
    // Quiet-hours / cap-exceeded: queue for morning drain. telegramInboxQueue
    // has `reason` column with values 'cap-exceeded' | 'quiet-hours'.
    const p = await getPool();
    const db = drizzle(p);
    await db.insert(telegramInboxQueue).values({
      body: event.body,
      reason: check.reason ?? 'cap-exceeded',
    });
    return { sent: false, queued: true, reason: check.reason };
  }

  // Phase 2 will replace this stub with a real Telegram `sendMessage` call.
  // Phase 1 keeps the sender path exercisable without a real bot token so
  // verify-cap.mjs can drive the cap gate end-to-end.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      phase1Stub: true,
      bodyPreview: event.body.slice(0, 80),
      count: check.count,
    }),
  );
  return { sent: true, queued: false };
}
