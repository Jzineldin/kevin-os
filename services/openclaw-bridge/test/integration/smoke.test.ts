/**
 * Live smoke test against the deployed openclaw-bridge Lambda.
 *
 * Skipped by default (requires AWS creds + bridge env). Run with:
 *   KOS_BRIDGE_INTEGRATION=1 \
 *   KOS_BRIDGE_URL=https://...lambda-url.eu-north-1.on.aws \
 *   KOS_BRIDGE_BEARER=<token> \
 *   AWS_REGION=eu-north-1 \
 *   pnpm exec vitest run test/integration/smoke.test.ts
 *
 * Uses AWS SDK's native SigV4 signer (no Python subprocess) so it works
 * inside vitest's worker pool.
 */
import { describe, it, expect } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const enabled = process.env.KOS_BRIDGE_INTEGRATION === '1';
const BRIDGE_URL = process.env.KOS_BRIDGE_URL ?? '';
const BEARER = process.env.KOS_BRIDGE_BEARER ?? '';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';

const describeIf = enabled && BRIDGE_URL && BEARER ? describe : describe.skip;

async function sigV4Get(path: string): Promise<{ status: number; body: any }> {
  const u = new URL(BRIDGE_URL + path);
  const creds = await fromNodeProviderChain()();
  const signer = new SignatureV4({
    service: 'lambda',
    region: REGION,
    credentials: creds,
    sha256: Sha256,
  });

  // Build query param object for SigV4 (it signs query separately from path)
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  const signed = await signer.sign({
    method: 'GET',
    hostname: u.hostname,
    path: u.pathname,
    query,
    protocol: 'https:',
    headers: {
      host: u.hostname,
      'x-bridge-auth': `Bearer ${BEARER}`,
    },
  });

  const resp = await fetch(u.toString(), { method: 'GET', headers: signed.headers as Record<string, string> });
  const text = await resp.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

describeIf('openclaw-bridge smoke (live)', () => {
  it('ping returns ok + current time', async () => {
    const r = await sigV4Get('/ping');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.version).toBe('bridge-v1');
    expect(new Date(r.body.now).getTime()).toBeGreaterThan(Date.now() - 60_000);
  }, 30_000);

  it('search for a known name returns matches', async () => {
    const r = await sigV4Get('/entity/search?q=Robin');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.matches)).toBe(true);
    expect(r.body.matches.length).toBeGreaterThanOrEqual(1);
    expect(r.body.matches[0].type).toBe('person');
  }, 30_000);

  it('search rejects q_too_short', async () => {
    const r = await sigV4Get('/entity/search?q=a');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('q_too_short');
  }, 30_000);

  it('entity dossier returns entity + mentions', async () => {
    const search = await sigV4Get('/entity/search?q=Robin');
    const id = search.body.matches[0].id;
    const r = await sigV4Get(`/entity/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.entity.name).toBe('Robin');
    expect(Array.isArray(r.body.mentions)).toBe(true);
  }, 30_000);

  it('unknown route returns 404', async () => {
    const r = await sigV4Get('/nonexistent');
    expect(r.status).toBe(404);
  }, 30_000);
});
