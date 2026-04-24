/**
 * @kos/dashboard-api — in-VPC Lambda behind a Function URL (AWS_IAM auth).
 *
 * Single Node 22 ARM64 Lambda with an internal method+path router — per
 * RESEARCH §7 "one Lambda with an internal mini-router is cheaper and
 * simpler than one Lambda per route for ≤ 10 routes". All 10 routes from
 * the §7 routing table are registered via the side-effect imports below:
 *
 *   GET  /today                            → handlers/today
 *   GET  /entities/list                    → handlers/entities
 *   GET  /entities/:id                     → handlers/entities
 *   GET  /entities/:id/timeline?cursor=…   → handlers/timeline
 *   GET  /inbox                            → handlers/inbox
 *   POST /inbox/:id/approve                → handlers/inbox
 *   POST /inbox/:id/edit                   → handlers/inbox
 *   POST /inbox/:id/skip                   → handlers/inbox
 *   POST /entities/:id/merge               → handlers/merge (stub → Plan 08)
 *   POST /entities/:id/merge/resume        → handlers/merge (stub → Plan 08)
 *   POST /capture                          → handlers/capture
 *
 * Auth / network: Function URL with `authType: AWS_IAM`; Vercel calls
 * with SigV4 (Plan 04 wires it). VPC-private Lambda so RDS Proxy is
 * reachable over the private network — never over the public internet.
 */
import type { LambdaFunctionURLHandler } from 'aws-lambda';
import { route } from './router.js';
import './handlers/today.js';
import './handlers/entities.js';
import './handlers/timeline.js';
import './handlers/inbox.js';
import './handlers/merge.js';
import './handlers/capture.js';
import './handlers/calendar.js';

/**
 * Constant-time string compare — prevents timing oracles on the shared
 * Bearer token. Identical pattern to apps/dashboard/src/lib/constant-time.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function verifyBearer(headers: Record<string, string | undefined> | undefined): boolean {
  const hdr = headers?.authorization ?? headers?.Authorization;
  if (!hdr || typeof hdr !== 'string') return false;
  const m = /^Bearer\s+(.+)$/.exec(hdr.trim());
  if (!m) return false;
  const presented = m[1]!;
  const expected = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!expected) {
    console.error('[dashboard-api] KOS_DASHBOARD_BEARER_TOKEN env not set');
    return false;
  }
  return constantTimeEqual(presented, expected);
}

export const handler: LambdaFunctionURLHandler = async (event) => {
  // Bearer auth — enforced here because Function URL is AuthType=NONE
  // (switched 2026-04-24 after long-term-IAM-user SigV4 invocations
  // returned 403 despite matching identity + resource policies; root
  // cause unresolved). Shared secret matches the one Vercel middleware
  // already gates the /login page with.
  if (!verifyBearer(event.headers as Record<string, string | undefined> | undefined)) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }

  try {
    const res = await route(event);
    return {
      ...res,
      headers: {
        'content-type': 'application/json',
        ...(res.headers ?? {}),
      },
    };
  } catch (err: unknown) {
    // Last-resort guard. Handler-level errors should be caught inside
    // each handler; this fires only on unexpected throws (e.g. pg.Pool
    // startup failure, zod exit-validation failure on a path that
    // surfaced bad data from the DB).
    console.error('[dashboard-api] unhandled', err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'internal' }),
    };
  }
};
