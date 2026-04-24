/**
 * Server-side SigV4 client for `services/dashboard-api` (Lambda Function
 * URL, AuthType=AWS_IAM) and `services/dashboard-listen-relay` (also
 * service=lambda). One AwsClient instance is reused across requests on a
 * warm Vercel lane; credentials come from per-Vercel-env vars that are
 * NEVER prefixed NEXT_PUBLIC_* (see eslint guard in Plan 01 +
 * 03-RESEARCH §16, T-3-05-04).
 *
 * Public surface:
 *   - callApi<T>(path, init, schema): zod-validated JSON response.
 *   - callRelay(path, init): raw Response for streaming / long-poll.
 *
 * Required env vars at runtime (documented in 03-05-SUMMARY.md):
 *   - KOS_DASHBOARD_API_URL       (Lambda Function URL base)
 *   - KOS_DASHBOARD_RELAY_URL     (Fargate relay Function URL base — Plan 07 uses this)
 *   - AWS_ACCESS_KEY_ID_DASHBOARD
 *   - AWS_SECRET_ACCESS_KEY_DASHBOARD
 *   - AWS_REGION (default 'eu-north-1')
 *
 * Why aws4fetch not @aws-sdk/signature-v4: ~1 KB vs ~4 MB cold-start hit
 * on Vercel Node. Pure Web Crypto, no deps (03-RESEARCH §6).
 */
import { AwsClient } from 'aws4fetch';
import type { z } from 'zod';

let _client: AwsClient | null = null;

function getClient(): AwsClient {
  if (_client) return _client;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID_DASHBOARD;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY_DASHBOARD;
  if (!accessKeyId || !secretAccessKey) {
    // Throw at first use rather than at import time — lets the module
    // load inside test harnesses that stub env per-describe.
    throw new Error(
      'dashboard-api: AWS_ACCESS_KEY_ID_DASHBOARD / AWS_SECRET_ACCESS_KEY_DASHBOARD must be set on the Vercel runtime.',
    );
  }
  _client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    // Optional STS session token — required for IAM-user long-term keys that
    // hit 403 Forbidden against the Function URL (observed 2026-04-23 with
    // kos-dashboard-caller long-term keys; STS get-session-token creds work).
    // In production (Vercel), populate from a credential-vending endpoint or
    // leave unset if long-term keys work in your environment.
    ...(process.env.AWS_SESSION_TOKEN_DASHBOARD
      ? { sessionToken: process.env.AWS_SESSION_TOKEN_DASHBOARD }
      : {}),
    region: process.env.AWS_REGION ?? 'eu-north-1',
    service: 'lambda',
  });
  return _client;
}

// Exposed for tests that want to reset the memoised client between cases.
export function _resetClientForTests(): void {
  _client = null;
}

function apiBase(): string {
  const base = process.env.KOS_DASHBOARD_API_URL;
  if (!base) throw new Error('KOS_DASHBOARD_API_URL is not set on this runtime.');
  return base;
}

function relayBase(): string {
  const base = process.env.KOS_DASHBOARD_RELAY_URL;
  if (!base) throw new Error('KOS_DASHBOARD_RELAY_URL is not set on this runtime.');
  return base;
}

/**
 * SigV4-signed JSON fetch against dashboard-api.
 *
 * @throws Error with shape `dashboard-api <path> → <status>: <body>` on non-2xx.
 * @throws ZodError if the response body fails schema validation.
 */
export async function callApi<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodSchema<T>,
): Promise<T> {
  // 2026-04-24: switched from SigV4 to Bearer auth after the
  // kos-dashboard-caller IAM user hit undebugable 403 Forbidden against
  // the Function URL despite matching identity + resource policies.
  // Bearer token is the same shared secret Vercel middleware already
  // gates the /login page with — stored in KOS_DASHBOARD_BEARER_TOKEN.
  const bearer = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!bearer) {
    throw new Error('dashboard-api: KOS_DASHBOARD_BEARER_TOKEN not set on runtime.');
  }
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`dashboard-api ${path} → ${res.status}: ${body}`);
  }
  return schema.parse(await res.json());
}

/**
 * Bearer-auth fetch against dashboard-listen-relay. Returns the raw
 * Response so callers can pipe streaming bodies (used by Plan 07's SSE
 * proxy). Default content-type NOT injected — the relay sees whatever
 * headers you pass (plus Authorization).
 */
export async function callRelay(path: string, init: RequestInit): Promise<Response> {
  const bearer = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!bearer) {
    throw new Error('relay: KOS_DASHBOARD_BEARER_TOKEN not set on runtime.');
  }
  return fetch(`${relayBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(init.headers ?? {}),
    },
  });
}

export { AwsClient };
