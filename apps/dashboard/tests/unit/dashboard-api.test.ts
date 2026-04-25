/**
 * callApi — SigV4-signed fetch wrapper around dashboard-api.
 *
 * Targets (03-05-PLAN.md Task 2 behaviour):
 *   - URL base concatenation (KOS_DASHBOARD_API_URL + path)
 *   - response body parsed against the provided zod schema
 *   - throws on non-2xx with status + body in message
 *   - callRelay uses KOS_DASHBOARD_RELAY_URL but same AwsClient
 *
 * aws4fetch is mocked at module scope so the test never touches the
 * network. The mock records the request it was handed so we can assert
 * the URL was signed against the correct base.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn().mockImplementation(() => ({
    fetch: fetchMock,
  })),
}));

describe('callApi', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv('AWS_ACCESS_KEY_ID_DASHBOARD', 'AKIATESTKEY');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY_DASHBOARD', 'secret-key-test');
    vi.stubEnv('AWS_REGION', 'eu-north-1');
    vi.stubEnv('KOS_DASHBOARD_API_URL', 'https://abc123.lambda-url.eu-north-1.on.aws');
    vi.stubEnv('KOS_DASHBOARD_RELAY_URL', 'https://def456.lambda-url.eu-north-1.on.aws');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefixes BASE URL + signs via AwsClient + parses response via schema', async () => {
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

  it('merges caller headers with the default content-type', async () => {
    const { callApi } = await import('@/lib/dashboard-api');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await callApi('/today', { method: 'POST', headers: { 'x-trace': 'abc' } }, z.any());
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-trace': 'abc' });
  });
});

describe('callRelay', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv('AWS_ACCESS_KEY_ID_DASHBOARD', 'AKIATESTKEY');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY_DASHBOARD', 'secret-key-test');
    vi.stubEnv('AWS_REGION', 'eu-north-1');
    vi.stubEnv('KOS_DASHBOARD_RELAY_URL', 'https://def456.lambda-url.eu-north-1.on.aws');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs against KOS_DASHBOARD_RELAY_URL and returns raw Response', async () => {
    const { callRelay } = await import('@/lib/dashboard-api');
    const upstream = new Response('stream-bytes', { status: 200 });
    fetchMock.mockResolvedValueOnce(upstream);

    const res = await callRelay('/stream/today', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://def456.lambda-url.eu-north-1.on.aws/stream/today');
    expect(res).toBe(upstream);
  });
});
