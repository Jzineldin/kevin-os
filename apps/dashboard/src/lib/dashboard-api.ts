/**
 * Server-side Bearer-auth clients for `services/dashboard-api` (Lambda
 * Function URL) and `services/dashboard-listen-relay`. One shared secret
 * (`KOS_DASHBOARD_BEARER_TOKEN`) gates both — the same token Vercel
 * middleware already uses to protect /login.
 *
 * Public surface:
 *   - callApi<T>(path, init, schema): zod-validated JSON response.
 *   - callRelay(path, init): raw Response for streaming / long-poll.
 *
 * Required env vars at runtime:
 *   - KOS_DASHBOARD_API_URL       (Lambda Function URL base)
 *   - KOS_DASHBOARD_RELAY_URL     (relay Function URL base, used by SSE)
 *   - KOS_DASHBOARD_BEARER_TOKEN  (shared secret, set on Vercel)
 *
 * History: switched from SigV4 (aws4fetch) to Bearer on 2026-04-24 after
 * the kos-dashboard-caller IAM user hit undebugable 403s against the
 * Function URL despite matching identity + resource policies.
 */
import type { z } from 'zod';

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
 * Bearer-auth JSON fetch against dashboard-api.
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
