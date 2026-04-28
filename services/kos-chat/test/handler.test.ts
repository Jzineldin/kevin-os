/**
 * kos-chat handler tests.
 *
 * Dev EC2 CANNOT reach RDS directly → all DB calls are mocked.
 * Bedrock is also mocked (no real credentials in test env).
 *
 * Tests verify:
 *  1. Auth guard rejects missing bearer.
 *  2. Malformed body returns 400.
 *  3. Valid request → answer + citations + sessionId returned.
 *  4. Session ID is preserved across turns.
 *  5. Bedrock error maps to 502.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock DB module ────────────────────────────────────────────────────────
const mockExecute = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../src/db.js', () => ({
  OWNER_ID: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
  getDb: vi.fn().mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) }),
  getPool: vi.fn().mockResolvedValue({}),
  __setDbForTest: vi.fn(),
}));

// ── Mock sessions module ──────────────────────────────────────────────────
const mockResolveSession = vi.fn().mockResolvedValue('SESSION-01');
const mockLoadHistory = vi.fn().mockResolvedValue([]);
const mockAppendMessages = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/sessions.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
  loadHistory: (...args: unknown[]) => mockLoadHistory(...args),
  appendMessages: (...args: unknown[]) => mockAppendMessages(...args),
}));

// ── Mock secrets module ───────────────────────────────────────────────────
vi.mock('../src/secrets.js', () => ({
  getChatBearerToken: vi.fn().mockResolvedValue(null), // no auth in tests
  getNotionToken: vi.fn().mockResolvedValue('fake-notion-token'),
}));

// ── Mock context-loader ───────────────────────────────────────────────────
vi.mock('@kos/context-loader', () => ({
  loadKevinContextMarkdown: vi.fn().mockResolvedValue('# Kevin Context\nTale Forge CEO.'),
}));

// ── Mock Bedrock ──────────────────────────────────────────────────────────
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ── Mock drizzle sql (for hot-entity query) ───────────────────────────────
vi.mock('drizzle-orm', () => ({
  sql: vi.fn().mockReturnValue('SQL_PLACEHOLDER'),
}));

// Import handler AFTER mocks are set up.
import { handler } from '../src/handler.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /chat',
    rawPath: '/chat',
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: {
      http: { method: 'POST', path: '/chat', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
      accountId: '123',
      apiId: 'test',
      domainName: 'test.lambda-url.eu-north-1.on.aws',
      domainPrefix: 'test',
      stage: '$default',
      requestId: 'test-req',
      routeKey: 'POST /chat',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function mockBedrockAnswer(text: string): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('kos-chat handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
    mockResolveSession.mockResolvedValue('SESSION-01');
    mockLoadHistory.mockResolvedValue([]);
    mockAppendMessages.mockResolvedValue(undefined);
  });

  it('returns 401 when bearer token mismatch', async () => {
    const { getChatBearerToken } = await import('../src/secrets.js');
    vi.mocked(getChatBearerToken).mockResolvedValueOnce('secret-token');

    const event = makeEvent({ message: 'hello' }, { authorization: 'Bearer wrong' });
    const res = await handler(event);
    expect(typeof res === 'object' && 'statusCode' in res && res.statusCode).toBe(401);
  });

  it('returns 400 for empty message', async () => {
    const event = makeEvent({ message: '' });
    const res = await handler(event);
    expect(typeof res === 'object' && 'statusCode' in res && res.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = { ...makeEvent({}), body: '{ bad json' };
    const res = await handler(event);
    expect(typeof res === 'object' && 'statusCode' in res && res.statusCode).toBe(400);
  });

  it('returns answer + sessionId on success', async () => {
    mockBedrockAnswer('Kevin runs Tale Forge AB.');
    const event = makeEvent({ message: 'What do I do?' });
    const res = await handler(event);
    if (typeof res === 'string') throw new Error('Expected object response');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.answer).toContain('Tale Forge');
    expect(body.sessionId).toBe('SESSION-01');
    expect(Array.isArray(body.citations)).toBe(true);
  });

  it('preserves provided sessionId', async () => {
    mockBedrockAnswer('You asked a follow-up.');
    mockResolveSession.mockResolvedValueOnce('EXISTING-SESSION');
    const event = makeEvent({ message: 'Follow up', sessionId: 'EXISTING-SESSION' });
    const res = await handler(event);
    if (typeof res === 'string') throw new Error('Expected object response');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.sessionId).toBe('EXISTING-SESSION');
    expect(mockResolveSession).toHaveBeenCalledWith('EXISTING-SESSION', 'dashboard', 'default');
  });

  it('persists user + assistant messages after successful answer', async () => {
    mockBedrockAnswer('Persisted answer.');
    const event = makeEvent({ message: 'Save this' });
    await handler(event);
    expect(mockAppendMessages).toHaveBeenCalledWith('SESSION-01', 'Save this', 'Persisted answer.');
  });

  it('returns 502 when Bedrock call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('throttled by Bedrock'));
    const event = makeEvent({ message: 'any question' });
    const res = await handler(event);
    if (typeof res === 'string') throw new Error('Expected object response');
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body as string);
    expect(body.error).toBe('model_unavailable');
  });

  it('uses telegram source + externalId when provided', async () => {
    mockBedrockAnswer('Telegram answer.');
    const event = makeEvent({
      message: 'hello from tg',
      source: 'telegram',
      externalId: '987654321',
    });
    const res = await handler(event);
    if (typeof res === 'string') throw new Error('Expected object response');
    expect(res.statusCode).toBe(200);
    expect(mockResolveSession).toHaveBeenCalledWith(undefined, 'telegram', '987654321');
  });

  it('does not block answer if appendMessages fails (non-fatal)', async () => {
    mockBedrockAnswer('Answer survives DB error.');
    mockAppendMessages.mockRejectedValueOnce(new Error('DB down'));
    const event = makeEvent({ message: 'test' });
    const res = await handler(event);
    if (typeof res === 'string') throw new Error('Expected object response');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).answer).toContain('Answer survives');
  });
});
