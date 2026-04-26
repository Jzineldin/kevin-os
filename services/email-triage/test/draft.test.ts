/**
 * Email-triage draft tests (Plan 04-04 Task 1).
 *
 * 5 tests covering:
 *   - urgent classification → valid DraftOutput
 *   - reply_to mirrors the original From
 *   - <email_content> wrap is present in the user prompt
 *   - Sonnet 4.6 model id pinned
 *   - model garbage → safe fallback (body='', tone_notes containing
 *     'model output invalid')
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  })),
}));

const baseInput = {
  from: 'Christina <christina@vc.example>',
  to: ['kevin@tale-forge.app'],
  subject: 'Bridge round timing',
  body: 'Kevin, can we close on Friday?',
  receivedAt: '2026-04-25T07:00:00.000Z',
  kevinContextBlock: '## Active deals\nBridge round',
  classification: 'urgent' as const,
};

function mockToolUse(input: unknown, name = 'record_draft') {
  return {
    content: [{ type: 'tool_use', name, input }],
    usage: { input_tokens: 200, output_tokens: 80 },
  };
}

describe('runDraftAgent (Sonnet 4.6)', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('urgent → valid DraftOutput shape', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockToolUse({
        subject: 'Re: Bridge round timing',
        body: 'Christina — Friday works. Sending term sheet by EOD Thursday. /Kevin',
        reply_to: 'christina@vc.example',
        tone_notes: 'English, direct — investor close-of-deal context',
      }),
    );
    const { runDraftAgent } = await import('../src/draft.js');
    const r = await runDraftAgent(baseInput);
    expect(r.output.subject).toMatch(/^Re:/);
    expect(r.output.body.length).toBeGreaterThan(0);
    expect(r.output.tone_notes.length).toBeGreaterThan(0);
  });

  it('reply_to matches input.from when model returns the address', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockToolUse({
        subject: 'Re: Bridge round timing',
        body: 'Friday works. /Kevin',
        reply_to: 'christina@vc.example',
        tone_notes: 'English',
      }),
    );
    const { runDraftAgent } = await import('../src/draft.js');
    const r = await runDraftAgent(baseInput);
    expect(r.output.reply_to).toContain('christina@vc.example');
  });

  it('<email_content> wrap is present in the user prompt', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockToolUse({
        subject: 'Re: x',
        body: 'ok',
        reply_to: 'x@y.example',
        tone_notes: 'short',
      }),
    );
    const { runDraftAgent } = await import('../src/draft.js');
    await runDraftAgent(baseInput);
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.messages[0]?.content).toMatch(/<email_content>/);
    expect(call.messages[0]?.content).toMatch(/<\/email_content>/);
  });

  it('Sonnet 4.6 model id is pinned', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockToolUse({
        subject: 'Re: x',
        body: 'ok',
        reply_to: 'x@y.example',
        tone_notes: 'short',
      }),
    );
    const { runDraftAgent, SONNET_4_6_MODEL_ID } = await import('../src/draft.js');
    expect(SONNET_4_6_MODEL_ID).toBe('eu.anthropic.claude-sonnet-4-6');
    await runDraftAgent(baseInput);
    const call = messagesCreate.mock.calls[0]?.[0] as { model: string };
    expect(call.model).toBe('eu.anthropic.claude-sonnet-4-6');
  });

  it('non-tool_use → safe fallback (empty body, model-output-invalid tone)', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { runDraftAgent } = await import('../src/draft.js');
    const r = await runDraftAgent(baseInput);
    expect(r.output.body).toBe('');
    expect(r.output.tone_notes).toContain('model output invalid');
    expect(r.output.reply_to).toBe(baseInput.from);
  });
});
