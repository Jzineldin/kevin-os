/**
 * relay-proxy Lambda — Option B ingress (RESEARCH §13).
 *
 * Forwards SigV4-authed HTTP calls from Vercel (the SSE Route Handler) to
 * the internal NetworkLoadBalancer fronting the `dashboard-listen-relay`
 * Fargate task. Stays inside the VPC because the NLB is `scheme: internal`.
 *
 * Contract:
 *   GET  /events?cursor=<seq>&wait=<0-25>  -> proxied verbatim
 *   GET  /healthz                          -> proxied verbatim
 *   (POST is supported in case the relay grows a control surface later.)
 *
 * Long-poll notes:
 *   - Vercel side polls with wait <= 25; the Fargate task enforces
 *     `Math.min(wait, 25)`. Lambda timeout 30s gives 5s headroom for
 *     connection setup + JSON deserialization.
 *   - AbortSignal.timeout(28_000) prevents Lambda from running all the way
 *     to the 30s hard timeout (which would surface as 502 at the Function
 *     URL rather than a clean 504).
 *
 * Cost: single-user, ~20 long-poll requests per active session. At 256 MB
 * / 30s avg Lambda runtime this is well under $1/month.
 *
 * No external deps — Node 22 native `fetch`.
 */
import type { LambdaFunctionURLHandler } from 'aws-lambda';

const DEFAULT_TIMEOUT_MS = 28_000;

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
  const expected = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!expected) {
    console.error('[relay-proxy] KOS_DASHBOARD_BEARER_TOKEN env not set');
    return false;
  }
  return constantTimeEqual(m[1]!, expected);
}

export const handler: LambdaFunctionURLHandler = async (event) => {
  // Bearer auth — Function URL is AuthType=NONE (switched 2026-04-24 after
  // long-term-IAM-user SigV4 returned 403 Forbidden mysteriously).
  if (!verifyBearer(event.headers as Record<string, string | undefined> | undefined)) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }

  const target = process.env.RELAY_INTERNAL_URL;
  if (!target) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'RELAY_INTERNAL_URL not configured' }),
    };
  }

  const method = event.requestContext.http.method;
  const rawPath = event.rawPath || '/';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${target}${rawPath}${query}`;

  // Forward body only for methods that define one. Lambda Function URL
  // base64-encodes binary bodies; for text/JSON bodies, fall back to string.
  const forwardBody =
    method === 'POST' || method === 'PUT' || method === 'PATCH'
      ? event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64')
        : (event.body ?? '')
      : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(forwardBody != null
          ? { 'content-type': event.headers['content-type'] ?? 'application/json' }
          : {}),
      },
      body: forwardBody as BodyInit | undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    const text = await res.text();
    return {
      statusCode: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
      body: text,
    };
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      statusCode: isAbort ? 504 : 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({
        error: isAbort ? 'upstream_timeout' : 'upstream_unreachable',
        message: err instanceof Error ? err.message : String(err),
      }),
    };
  }
};
