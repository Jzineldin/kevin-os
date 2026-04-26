/**
 * oauth.test.ts — gmail-poller OAuth refresh-token exchange.
 *
 * Mirrors the calendar-reader oauth.test.ts (same shared
 * `kos/gcal-oauth-<account>` Secrets Manager entry).
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
  const oauth = await import('../src/oauth.js');
  oauth.__resetForTests();
  (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
});

describe('gmail-poller getAccessToken', () => {
  it('reads kos/gcal-oauth-<account> and exchanges refresh_token → access_token', async () => {
    sendSpy.mockResolvedValue({ SecretString: VALID_SECRET_PAYLOAD });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GCAL_OAUTH_REFRESH_SUCCESS,
      text: async () => '',
    });

    const { getAccessToken } = await import('../src/oauth.js');
    const tok = await getAccessToken('kevin-elzarka');

    expect(tok).toBe(GCAL_OAUTH_REFRESH_SUCCESS.access_token);
    const cmd = sendSpy.mock.calls[0]![0] as { input: { SecretId: string } };
    expect(cmd.input.SecretId).toBe('kos/gcal-oauth-kevin-elzarka');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const bodyStr = String((init as RequestInit).body);
    expect(bodyStr).toContain('grant_type=refresh_token');
  });

  it('reuses cached token within TTL', async () => {
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
    vi.setSystemTime(new Date('2026-04-25T10:30:00Z'));
    const t2 = await getAccessToken('kevin-elzarka');
    expect(t1).toBe(t2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('400 invalid_grant → actionable error pointing at bootstrap-google-oauth.mjs', async () => {
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
      /bootstrap-google-oauth\.mjs --account kevin-taleforge/,
    );
  });

  it('missing secret → clear error referencing operator script', async () => {
    sendSpy.mockResolvedValue({ SecretString: undefined });
    const { getAccessToken } = await import('../src/oauth.js');
    await expect(getAccessToken('kevin-elzarka')).rejects.toThrow(
      /Secret kos\/gcal-oauth-kevin-elzarka missing.*bootstrap-google-oauth\.mjs/s,
    );
  });
});
