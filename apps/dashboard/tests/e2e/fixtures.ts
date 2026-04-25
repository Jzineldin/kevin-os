import { test as base, expect, request as apiRequest } from '@playwright/test';

/**
 * E2E fixtures for @kos/dashboard. Wave 0 surfaces only the auth helper —
 * concrete page-object helpers land alongside the view plans (03-04..03-10).
 *
 * `authCookie()` obtains a signed-in storageState by POSTing
 * `KOS_TEST_BEARER_TOKEN` to `/api/auth/login` and capturing the
 * httpOnly `kos_session` cookie.
 *
 * Pitfall P-10 (RESEARCH §17): never read `process.env.KOS_TEST_BEARER_TOKEN`
 * from client-side code. This helper runs server-side / in Playwright runner
 * only.
 */
export async function authCookie(baseURL: string): Promise<string> {
  const token = process.env.KOS_TEST_BEARER_TOKEN;
  if (!token) {
    throw new Error('KOS_TEST_BEARER_TOKEN not set — cannot obtain auth cookie');
  }
  const ctx = await apiRequest.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { token } });
  if (!res.ok()) {
    throw new Error(`auth login failed: ${res.status()} ${await res.text()}`);
  }
  const state = await ctx.storageState();
  return JSON.stringify(state);
}

export const test = base.extend({});

export { expect };
