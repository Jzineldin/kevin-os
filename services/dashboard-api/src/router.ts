/**
 * Tiny method+path router. No framework, no dependencies — per RESEARCH §7
 * "single Lambda with internal mini-router" (one Lambda for all 10 routes
 * keeps cold-starts + IAM wiring minimal).
 *
 * Each handler module calls `register(method, path, handler)` at import
 * time; `src/index.ts` imports every handler module so their side-effects
 * run once per warm instance.
 *
 * Route patterns support `:name` params which compile to `([^/]+)` and
 * emerge in ctx.params as decoded strings.
 */
import type { LambdaFunctionURLEvent } from 'aws-lambda';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type Ctx = {
  method: Method;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
  headers: Record<string, string | undefined>;
};

export type RouteResponse = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};

export type Handler = (ctx: Ctx) => Promise<RouteResponse>;

type Route = {
  method: Method;
  pattern: RegExp;
  names: string[];
  handler: Handler;
};

const routes: Route[] = [];

export function register(method: Method, path: string, handler: Handler): void {
  const names: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const pattern = new RegExp('^' + source + '$');
  routes.push({ method, pattern, names, handler });
}

/** Test helper — wipes the registered-route table. Production code never calls. */
export function __clearRoutesForTest(): void {
  routes.length = 0;
}

/** Test helper — introspect the registered route table. */
export function __listRoutesForTest(): ReadonlyArray<{ method: Method; source: string }> {
  return routes.map((r) => ({ method: r.method, source: r.pattern.source }));
}

export async function route(event: LambdaFunctionURLEvent): Promise<RouteResponse> {
  const method = event.requestContext.http.method as Method;
  const path = event.requestContext.http.path;

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.names.forEach((n, i) => {
      const raw = m[i + 1];
      if (raw !== undefined) params[n] = decodeURIComponent(raw);
    });
    return r.handler({
      method,
      path,
      params,
      query: (event.queryStringParameters as Record<string, string>) ?? {},
      body: event.body ?? null,
      headers: event.headers ?? {},
    });
  }
  return {
    statusCode: 404,
    body: JSON.stringify({ error: 'not_found', method, path }),
  };
}
