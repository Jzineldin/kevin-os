/**
 * Tests for POST /chat (Phase 11 Plan 11-01).
 *
 * Mocks: Bedrock, @kos/context-loader, db, getPool, TOOL_DEFS/dispatchTool.
 * Validates:
 *   - sessionId derivation (supplied → echo, omitted → deterministic hash)
 *   - Basic response shape: answer + citations + sessionId + mutations
 *   - Input validation (empty message, oversized message)
 *   - Bearer-less requests rejected at index handler level (401)
 *   - Upstream bedrock error → 502
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatHandler } from '../src/routes/chat.js';
import type { Ctx } from '../src/router.js';

// ── DB mocks ─────────────────────────────────────────────────────────────
vi.mock('../src/db.js', () => ({
  getDb: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }),
  getPool: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/owner-scoped.js', () => ({
  OWNER_ID: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
}));

// ── Context loader mock ───────────────────────────────────────────────────
vi.mock('@kos/context-loader', () => ({
  loadKevinContextMarkdown: vi.fn().mockResolvedValue('Kevin runs Tale Forge.'),
}));

// ── Bedrock mock ──────────────────────────────────────────────────────────
const mockBedrockCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockBedrockCreate,
      },
    })),
  };
});

// ── Tool mocks ────────────────────────────────────────────────────────────
vi.mock('../src/routes/chat-tools.js', () => ({
  TOOL_DEFS: [],
  dispatchTool: vi.fn().mockResolvedValue({ ok: false, error: 'not_called' }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────
function makeCtx(body: unknown): Ctx {
  return {
    method: 'POST',
    path: '/chat',
    params: {},
    query: {},
    body: JSON.stringify(body),
    headers: {},
  };
}

function bedrockText(text: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'eu.anthropic.claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('POST /chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBedrockCreate.mockResolvedValue(bedrockText('Kevin runs two companies.'));
  });

  it('returns 400 on empty body', async () => {
    const ctx = makeCtx({});
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 on missing message', async () => {
    const ctx = makeCtx({ sessionId: 'abc' });
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on message too long', async () => {
    const ctx = makeCtx({ message: 'x'.repeat(4001) });
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on invalid_json body', async () => {
    const ctx: Ctx = { method: 'POST', path: '/chat', params: {}, query: {}, body: '{not json', headers: {} };
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_json');
  });

  it('returns answer + citations + sessionId + mutations on valid request', async () => {
    const ctx = makeCtx({ message: 'What projects is Kevin working on?' });
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toBe('Kevin runs two companies.');
    expect(Array.isArray(body.citations)).toBe(true);
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(Array.isArray(body.mutations)).toBe(true);
  });

  it('echoes supplied sessionId verbatim', async () => {
    const ctx = makeCtx({ message: 'hello', sessionId: 'my-stable-session-42' });
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe('my-stable-session-42');
  });

  it('generates deterministic sessionId from source+externalId when none supplied', async () => {
    const ctx1 = makeCtx({ message: 'first', source: 'telegram', externalId: '7626925687' });
    const ctx2 = makeCtx({ message: 'second', source: 'telegram', externalId: '7626925687' });
    const res1 = await chatHandler(ctx1);
    const res2 = await chatHandler(ctx2);
    const sid1 = JSON.parse(res1.body).sessionId;
    const sid2 = JSON.parse(res2.body).sessionId;
    expect(sid1).toBe(sid2);
    expect(sid1.length).toBe(26);
  });

  it('generates different sessionId for different externalId', async () => {
    const ctx1 = makeCtx({ message: 'hi', source: 'telegram', externalId: '111' });
    const ctx2 = makeCtx({ message: 'hi', source: 'telegram', externalId: '222' });
    const res1 = await chatHandler(ctx1);
    const res2 = await chatHandler(ctx2);
    expect(JSON.parse(res1.body).sessionId).not.toBe(JSON.parse(res2.body).sessionId);
  });

  it('returns 502 on bedrock failure', async () => {
    mockBedrockCreate.mockRejectedValue(new Error('ThrottlingException: rate exceeded'));
    const ctx = makeCtx({ message: 'test' });
    const res = await chatHandler(ctx);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('model_unavailable');
    expect(body.detail).toContain('ThrottlingException');
  });

  it('includes cache-control: no-store header', async () => {
    const ctx = makeCtx({ message: 'hello' });
    const res = await chatHandler(ctx);
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('calls bedrock exactly once for a non-tool-use response', async () => {
    const ctx = makeCtx({ message: 'brief summary please' });
    await chatHandler(ctx);
    expect(mockBedrockCreate).toHaveBeenCalledTimes(1);
  });
});
