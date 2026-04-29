/**
 * OpenClaw ↔ KOS RDS read-only bridge.
 *
 * Runs in the same VPC as dashboard-api; exposes a tiny JSON API gated by
 * a single bearer token (BRIDGE_BEARER_SECRET_ARN) so OpenClaw skills
 * can query the authoritative entity_index / mention_events without
 * duplicating them into memi SQLite (Phase B consolidation).
 *
 * Endpoints:
 *   GET /ping                     → { ok, now, version }
 *   GET /entity/search?q=<name>   → { matches: [...] }
 *   GET /entity/:id               → { entity, mentions: [last 20] }
 *
 * Intentionally tiny, read-only, no Notion writes, no LLM calls.
 * If this Lambda dies, dashboard-api + briefs are unaffected.
 */
import type { LambdaFunctionURLHandler } from 'aws-lambda';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const OWNER_ID = process.env.KEVIN_OWNER_ID ?? '';
const BEARER_SECRET_ARN = process.env.BRIDGE_BEARER_SECRET_ARN;
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;
const DB_HOST = process.env.RDS_PROXY_ENDPOINT;
const DB_NAME = process.env.RDS_DATABASE ?? 'kos';
const DB_USER = process.env.RDS_USER ?? 'kos_openclaw_bridge';

let cachedPool: pg.Pool | null = null;
let cachedBearer: string | null = null;
const secrets = new SecretsManagerClient({});

async function getSecret(arn: string): Promise<string> {
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return r.SecretString ?? '';
}

async function getBearer(): Promise<string> {
  if (cachedBearer) return cachedBearer;
  if (!BEARER_SECRET_ARN) throw new Error('BRIDGE_BEARER_SECRET_ARN not set');
  cachedBearer = (await getSecret(BEARER_SECRET_ARN)).trim();
  return cachedBearer;
}

async function getPool(): Promise<pg.Pool> {
  if (cachedPool) return cachedPool;
  if (!DB_SECRET_ARN || !DB_HOST) throw new Error('DB secrets/host not set');
  const secret = JSON.parse(await getSecret(DB_SECRET_ARN));
  cachedPool = new pg.Pool({
    host: DB_HOST,
    port: 5432,
    user: DB_USER,
    password: secret.password,
    database: DB_NAME,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  return cachedPool;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler: LambdaFunctionURLHandler = async (event) => {
  // Bearer gate
  const hdr = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(hdr);
  if (!m) return json(401, { error: 'missing_bearer' });
  const expected = await getBearer();
  if (!timingSafeEq(m[1]!, expected)) return json(401, { error: 'bad_bearer' });

  const path = event.requestContext?.http?.path ?? '/';
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'GET') return json(405, { error: 'method_not_allowed' });

  if (path === '/ping') {
    return json(200, { ok: true, now: new Date().toISOString(), version: 'bridge-v1' });
  }

  if (!OWNER_ID) return json(500, { error: 'owner_id_not_set' });
  const pool = await getPool();

  // /entity/search?q=...
  if (path === '/entity/search') {
    const q = (event.queryStringParameters?.q ?? '').trim();
    if (q.length < 2) return json(400, { error: 'q_too_short' });
    const { rows } = await pool.query<{
      id: string; name: string; type: string; org: string | null; last_touch: string | null;
    }>(
      `SELECT id, name, type, org, last_touch
       FROM entity_index
       WHERE owner_id = $1 AND name ILIKE $2
       ORDER BY last_touch DESC NULLS LAST
       LIMIT 20`,
      [OWNER_ID, `%${q}%`],
    );
    return json(200, { matches: rows });
  }

  // /entity/:id
  const entMatch = /^\/entity\/([0-9a-f-]{36})$/i.exec(path);
  if (entMatch) {
    const id = entMatch[1]!;
    const ent = await pool.query(
      `SELECT id, name, type, org, role, relationship, status, seed_context, last_touch,
              manual_notes, confidence, linked_projects, aliases
       FROM entity_index
       WHERE id = $1 AND owner_id = $2
       LIMIT 1`,
      [id, OWNER_ID],
    );
    if (ent.rows.length === 0) return json(404, { error: 'not_found' });
    const mentions = await pool.query(
      `SELECT id, capture_id, source, context, occurred_at
       FROM mention_events
       WHERE entity_id = $1
       ORDER BY occurred_at DESC
       LIMIT 20`,
      [id],
    );
    return json(200, { entity: ent.rows[0], mentions: mentions.rows });
  }

  return json(404, { error: 'no_such_route', path });
};
