/**
 * oauth.test.ts — getAccessToken refresh-token exchange (Plan 08-01 Task 1).
 *
 * Behavioural coverage:
 *   1. getAccessToken reads Secrets Manager, exchanges refresh_token →
 *      access_token (mock fetch).
 *   2. Cached access_token reused on second call within 50 min.
 *   3. 400 invalid_grant → actionable error referencing
 *      bootstrap-gcal-oauth.mjs.
 *   4. Missing secret entry → clear error pointing at the operator script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GCAL_OAUTH_REFRESH_SUCCESS,
  GCAL_OAUTH_REFRESH_INVALID,
} from '@kos/test-fixtures';

const sendSpy = vi.fn();

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: sendSpy,
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

const VALID_SECRET_PAYLOAD = JSON.stringify({
  client_id: 'cid.apps.googleusercontent.com',
  client_secret: 'csec',
  refresh_token: '1//rt-fake',
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  sendSpy.mockReset();
  // Clear the module-scope token cache between tests.
  const oauth = await import('../src/oauth.js');
  oauth.__resetForTests();
  // Reset the global fetch mock so each test wires its own.
  (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
});

describe('getAccessToken', () => {
  it('reads Secrets Manager and exchanges refresh_token → access_token', async () => {
    sendSpy.mockResolvedValue({ SecretString: VALID_SECRET_PAYLOAD });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GCAL_OAUTH_REFRESH_SUCCESS,
      text: async () => JSON.stringify(GCAL_OAUTH_REFRESH_SUCCESS),
    });

    const { getAccessToken } = await import('../src/oauth.js');
    const tok = await getAccessToken('kevin-elzarka');

    expect(tok).toBe(GCAL_OAUTH_REFRESH_SUCCESS.access_token);
    // Secrets Manager called with the per-account secret id.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const cmd = sendSpy.mock.calls[0]![0] as { input: { SecretId: string } };
    expect(cmd.input.SecretId).toBe('kos/gcal-oauth-kevin-elzarka');

    // OAuth call hits Google's token endpoint with grant_type=refresh_token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    expect((init as RequestInit).method).toBe('POST');
    const bodyStr = String((init as RequestInit).body);
    expect(bodyStr).toContain('grant_type=refresh_token');
    expect(bodyStr).toContain('client_id=cid.apps.googleusercontent.com');
    expect(bodyStr).toContain('refresh_token=1%2F%2Frt-fake');
  });

  it('reuses cached access_token on second call within TTL', async () => {
    sendSpy.mockResolvedValue({ SecretString: VALID_SECRET_PAYLOAD });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GCAL_OAUTH_REFRESH_SUCCESS,
      text: async () => '',
    });

    const { getAccessToken } = await import('../src/oauth.js');
    const t1 = await getAccessToken('kevin-elzarka');
    // Advance 30 min — well below the 50-min effective TTL.
    vi.setSystemTime(new Date('2026-04-25T10:30:00Z'));
    const t2 = await getAccessToken('kevin-elzarka');

    expect(t1).toBe(t2);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('400 invalid_grant surfaces actionable error referencing bootstrap-gcal-oauth.mjs', async () => {
    sendSpy.mockResolvedValue({ SecretString: VALID_SECRET_PAYLOAD });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => GCAL_OAUTH_REFRESH_INVALID,
      text: async () => JSON.stringify(GCAL_OAUTH_REFRESH_INVALID),
    });

    const { getAccessToken } = await import('../src/oauth.js');
    await expect(getAccessToken('kevin-taleforge')).rejects.toThrow(
      /bootstrap-gcal-oauth\.mjs --account kevin-taleforge/,
    );
  });

  it('missing Secrets Manager entry → clear error pointing at the operator script', async () => {
    sendSpy.mockResolvedValue({ SecretString: undefined });

    const { getAccessToken } = await import('../src/oauth.js');
    await expect(getAccessToken('kevin-elzarka')).rejects.toThrow(
      /Secret kos\/gcal-oauth-kevin-elzarka missing.*bootstrap-gcal-oauth\.mjs/s,
    );
  });
});
