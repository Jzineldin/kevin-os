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

export const handler: LambdaFunctionURLHandler = async (event) => {
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
