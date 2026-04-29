/**
 * Unit tests for openclaw-bridge handler.
 *
 * Covers:
 *   - Bearer gate (missing, bad, good via both Authorization and X-Bridge-Auth)
 *   - Route matching (/ping, /entity/search, /entity/:uuid, 404)
 *   - Method gate (non-GET → 405)
 *   - Input validation (q too short)
 *
 * DB is mocked via pg.Pool substitute — we only verify SQL shape + response wrapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Env setup MUST happen before any imports that consume process.env
process.env.KEVIN_OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
process.env.BRIDGE_BEARER_SECRET_ARN = 'arn:aws:secretsmanager:eu-north-1:0:secret:bearer';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:eu-north-1:0:secret:db';
process.env.RDS_PROXY_ENDPOINT = 'proxy.example.com';
process.env.RDS_DATABASE = 'kos';
process.env.RDS_USER = 'kos_openclaw_bridge';

// Mock @aws-sdk Secrets Manager — return different values based on requested ARN
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send(cmd: { i: { SecretId: string } }) {
      const arn = cmd.i.SecretId;
      if (arn.includes('bearer')) return { SecretString: 'test-bearer-token' };
      return { SecretString: JSON.stringify({ password: 'test-pass' }) };
    }
  },
  GetSecretValueCommand: class {
    constructor(public i: { SecretId: string }) {}
  },
}));

// Mock pg.Pool — shared query spy
const mockQuery = vi.fn();
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = mockQuery;
    },
  },
}));

const { handler } = await import('../src/handler.js');

function evt(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): any {
  return {
    headers: opts.headers ?? {},
    queryStringParameters: opts.query,
    requestContext: { http: { path: opts.path ?? '/', method: opts.method ?? 'GET' } },
  };
}

const GOOD = { authorization: 'Bearer test-bearer-token' };

describe('openclaw-bridge handler', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // ─────────────────────────────────────────────────
  describe('auth gate', () => {
    it('401 missing_bearer when no auth header', async () => {
      const r = (await handler(evt({ path: '/ping' }), {} as any, () => {})) as any;
      expect(r.statusCode).toBe(401);
      expect(JSON.parse(r.body).error).toBe('missing_bearer');
    });

    it('401 bad_bearer when wrong token', async () => {
      const r = (await handler(
        evt({ path: '/ping', headers: { authorization: 'Bearer wrong' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(401);
      expect(JSON.parse(r.body).error).toBe('bad_bearer');
    });

    it('200 with correct Authorization header', async () => {
      const r = (await handler(evt({ path: '/ping', headers: GOOD }), {} as any, () => {})) as any;
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.ok).toBe(true);
      expect(body.version).toBe('bridge-v1');
    });

    it('200 with X-Bridge-Auth custom header (SigV4 coexistence)', async () => {
      const r = (await handler(
        evt({ path: '/ping', headers: { 'x-bridge-auth': 'Bearer test-bearer-token' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).ok).toBe(true);
    });

    it('case-insensitive Bearer prefix', async () => {
      const r = (await handler(
        evt({ path: '/ping', headers: { authorization: 'bearer test-bearer-token' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(200);
    });

    it('rejects token with same length but wrong chars (constant-time)', async () => {
      const r = (await handler(
        evt({ path: '/ping', headers: { authorization: 'Bearer test-bearer-tokeX' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(401);
      expect(JSON.parse(r.body).error).toBe('bad_bearer');
    });
  });

  // ─────────────────────────────────────────────────
  describe('method gate', () => {
    it('405 on POST', async () => {
      const r = (await handler(
        evt({ path: '/ping', method: 'POST', headers: GOOD }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(405);
      expect(JSON.parse(r.body).error).toBe('method_not_allowed');
    });
  });

  // ─────────────────────────────────────────────────
  describe('route: /entity/search', () => {
    it('400 q_too_short when q is empty', async () => {
      const r = (await handler(
        evt({ path: '/entity/search', headers: GOOD, query: { q: '' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body).error).toBe('q_too_short');
    });

    it('400 q_too_short when q is 1 char', async () => {
      const r = (await handler(
        evt({ path: '/entity/search', headers: GOOD, query: { q: 'a' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(400);
    });

    it('200 returns matches array from DB', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'abc-123',
            name: 'Robin',
            type: 'person',
            org: 'Science Park',
            last_touch: '2026-04-25T20:39:11.027Z',
          },
        ],
      });
      const r = (await handler(
        evt({ path: '/entity/search', headers: GOOD, query: { q: 'Robin' } }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.matches).toHaveLength(1);
      expect(body.matches[0].name).toBe('Robin');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/FROM entity_index/i);
      expect(sql).toMatch(/ILIKE \$2/);
      expect(sql).toMatch(/owner_id = \$1/);
      expect(params).toEqual([process.env.KEVIN_OWNER_ID, '%Robin%']);
    });

    it('trims whitespace from q', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await handler(
        evt({ path: '/entity/search', headers: GOOD, query: { q: '  Robin  ' } }),
        {} as any,
        () => {},
      );
      const [, params] = mockQuery.mock.calls[0];
      expect(params[1]).toBe('%Robin%');
    });
  });

  // ─────────────────────────────────────────────────
  describe('route: /entity/:uuid', () => {
    const uuid = 'd8a714c1-e8cf-427f-abb0-6309a56858eb';

    it('200 returns entity + mentions', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: uuid, name: 'Robin', type: 'person' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'm1', capture_id: 'c1', source: 'telegram', context: 'hi', occurred_at: 'x' },
          ],
        });

      const r = (await handler(
        evt({ path: `/entity/${uuid}`, headers: GOOD }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.entity.name).toBe('Robin');
      expect(body.mentions).toHaveLength(1);

      const [entSql, entParams] = mockQuery.mock.calls[0];
      expect(entSql).toMatch(/FROM entity_index/i);
      expect(entSql).toMatch(/id = \$1 AND owner_id = \$2/);
      expect(entParams).toEqual([uuid, process.env.KEVIN_OWNER_ID]);

      const [mentSql, mentParams] = mockQuery.mock.calls[1];
      expect(mentSql).toMatch(/FROM mention_events/i);
      expect(mentSql).toMatch(/LIMIT 20/);
      expect(mentParams).toEqual([uuid]);
    });

    it('404 not_found when DB returns no rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const r = (await handler(
        evt({ path: `/entity/${uuid}`, headers: GOOD }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(404);
      expect(JSON.parse(r.body).error).toBe('not_found');
    });

    it('rejects non-UUID path (falls through to 404 no_such_route)', async () => {
      const r = (await handler(
        evt({ path: '/entity/notauuid', headers: GOOD }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(404);
      expect(JSON.parse(r.body).error).toBe('no_such_route');
    });
  });

  // ─────────────────────────────────────────────────
  describe('unknown routes', () => {
    it('404 no_such_route', async () => {
      const r = (await handler(
        evt({ path: '/foobar', headers: GOOD }),
        {} as any,
        () => {},
      )) as any;
      expect(r.statusCode).toBe(404);
      expect(JSON.parse(r.body).error).toBe('no_such_route');
      expect(JSON.parse(r.body).path).toBe('/foobar');
    });
  });
});
