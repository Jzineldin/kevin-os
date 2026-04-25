/**
 * callApi / callRelay — Bearer-auth fetch wrappers around dashboard-api
 * and dashboard-listen-relay (Lambda Function URLs).
 *
 * Targets (post-2026-04-24 Bearer migration):
 *   - URL base concatenation (KOS_DASHBOARD_API_URL + path)
 *   - Authorization: Bearer <token> header injected from env
 *   - response body parsed against the provided zod schema
 *   - throws on non-2xx with status + body in message
 *   - callRelay uses KOS_DASHBOARD_RELAY_URL and returns raw Response
 *
 * Global `fetch` is mocked so the test never touches the network.
 *
 * History: switched from SigV4 (aws4fetch) to Bearer on 2026-04-24 after
 * undebugable 403s on the kos-dashboard-caller IAM user.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callApi', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv('KOS_DASHBOARD_API_URL', 'https://abc123.lambda-url.eu-north-1.on.aws');
    vi.stubEnv('KOS_DASHBOARD_RELAY_URL', 'https://def456.lambda-url.eu-north-1.on.aws');
    vi.stubEnv('KOS_DASHBOARD_BEARER_TOKEN', 'test-bearer-secret');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefixes BASE URL + injects Bearer auth + parses response via schema', async () => {
    const { callApi } = await import('@/lib/dashboard-api');
    const payload = { brief: null, priorities: [], drafts: [], dropped: [], meetings: [] };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const schema = z.object({
      brief: z.null(),
      priorities: z.array(z.any()),
      drafts: z.array(z.any()),
      dropped: z.array(z.any()),
      meetings: z.array(z.any()),
    });

    const result = await callApi('/today', { method: 'GET' }, schema);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://abc123.lambda-url.eu-north-1.on.aws/today');
    expect(init.method).toBe('GET');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.authorization).toBe('Bearer test-bearer-secret');
    expect(result).toEqual(payload);
  });

  it('throws on non-2xx with status + body in message', async () => {
    const { callApi } = await import('@/lib/dashboard-api');
    fetchMock.mockResolvedValueOnce(
      new Response('internal boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(
      callApi('/today', { method: 'GET' }, z.any()),
    ).rejects.toThrow(/dashboard-api \/today → 500:/);
  });

  it('throws when response body fails schema validation', async () => {
    const { callApi } = await import('@/lib/dashboard-api');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const schema = z.object({ required: z.string() });
    await expect(callApi('/x', { method: 'GET' }, schema)).rejects.toBeTruthy();
  });

  it('merges caller headers with the default content-type and Bearer token', async () => {
    const { callApi } = await import('@/lib/dashboard-api');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await callApi('/today', { method: 'POST', headers: { 'x-trace': 'abc' } }, z.any());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer test-bearer-secret',
      'x-trace': 'abc',
    });
  });
});

describe('callRelay', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv('KOS_DASHBOARD_RELAY_URL', 'https://def456.lambda-url.eu-north-1.on.aws');
    vi.stubEnv('KOS_DASHBOARD_BEARER_TOKEN', 'test-bearer-secret');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hits KOS_DASHBOARD_RELAY_URL with Bearer auth and returns raw Response', async () => {
    const { callRelay } = await import('@/lib/dashboard-api');
    const upstream = new Response('stream-bytes', { status: 200 });
    fetchMock.mockResolvedValueOnce(upstream);

    const res = await callRelay('/stream/today', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://def456.lambda-url.eu-north-1.on.aws/stream/today');
    expect(init.headers.authorization).toBe('Bearer test-bearer-secret');
    expect(res).toBe(upstream);
  });
});
