import { afterEach, describe, expect, it } from 'vitest';
import {
  __clearRoutesForTest,
  __listRoutesForTest,
  register,
  route,
} from '../src/router.js';

function makeEvent(method: string, path: string, query: Record<string, string> = {}, body: string | null = null) {
  return {
    version: '2.0' as const,
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'anonymous',
      apiId: 'local',
      domainName: 'local',
      domainPrefix: 'local',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/1970:00:00:00 +0000',
      timeEpoch: 0,
    },
    queryStringParameters: query,
    body,
    isBase64Encoded: false,
  } as unknown as Parameters<typeof route>[0];
}

afterEach(() => {
  __clearRoutesForTest();
});

describe('router', () => {
  it('dispatches a registered GET route with extracted params', async () => {
    register('GET', '/entities/:id', async (ctx) => ({
      statusCode: 200,
      body: JSON.stringify({ seen: ctx.params['id'] }),
    }));

    const res = await route(makeEvent('GET', '/entities/7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'));
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { seen: string };
    expect(parsed.seen).toBe('7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c');
  });

  it('returns 404 for unknown path', async () => {
    register('GET', '/known', async () => ({ statusCode: 200, body: '{}' }));
    const res = await route(makeEvent('GET', '/unknown'));
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for known path but wrong method', async () => {
    register('GET', '/inbox', async () => ({ statusCode: 200, body: '{}' }));
    const res = await route(makeEvent('POST', '/inbox'));
    expect(res.statusCode).toBe(404);
  });

  it('passes query string to handler', async () => {
    register('GET', '/timeline', async (ctx) => ({
      statusCode: 200,
      body: JSON.stringify({ q: ctx.query['cursor'] ?? null }),
    }));
    const res = await route(makeEvent('GET', '/timeline', { cursor: 'abc' }));
    expect(JSON.parse(res.body)).toEqual({ q: 'abc' });
  });

  it('decodes URL-encoded params', async () => {
    register('GET', '/x/:v', async (ctx) => ({
      statusCode: 200,
      body: JSON.stringify({ v: ctx.params['v'] }),
    }));
    const res = await route(makeEvent('GET', '/x/hello%20world'));
    expect(JSON.parse(res.body)).toEqual({ v: 'hello world' });
  });

  it('matches two distinct routes independently', async () => {
    register('GET', '/a', async () => ({ statusCode: 200, body: 'A' }));
    register('GET', '/b', async () => ({ statusCode: 200, body: 'B' }));
    const a = await route(makeEvent('GET', '/a'));
    const b = await route(makeEvent('GET', '/b'));
    expect(a.body).toBe('A');
    expect(b.body).toBe('B');
  });

  it('registers routes that can be introspected for tests', () => {
    register('POST', '/capture', async () => ({ statusCode: 202, body: '{}' }));
    const rs = __listRoutesForTest();
    expect(rs.some((r) => r.method === 'POST' && /capture/.test(r.source))).toBe(true);
  });
});
