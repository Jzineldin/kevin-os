/**
 * runContentWriterAgent tests (Plan 08-02 Task 2 — 8 tests).
 *
 *   1. system prompt contains CW_SYSTEM_BASE + brand_voice + kevin_context +
 *      additional_context blocks.
 *   2. user message wraps topic_text in <user_content> delimiters.
 *   3. platform-specific suffix included in system prompt.
 *   4. invalid JSON output throws.
 *   5. media_urls defaults to [] when absent.
 *   6. content cap applied per platform (instagram = 2200).
 *   7. usage object captures token counts.
 *   8. Bedrock model id pinned to 'eu.anthropic.claude-sonnet-4-6'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  })),
}));

function mockTextOutput(input: unknown, usage = { input_tokens: 200, output_tokens: 80 }) {
  return {
    content: [{ type: 'text', text: JSON.stringify(input) }],
    usage,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    topicId: '01HZ0000000000000000000ABC',
    captureId: '01HZ0000000000000000000DEF',
    platform: 'instagram' as const,
    topicText: 'Tale Forge launched on App Store today',
    brandVoiceMarkdown: '# voice body',
    kevinContextBlock: '## Active deals\nBridge round',
    additionalContextBlock: '## Dossier\nDamien at Almi',
    ...overrides,
  };
}

describe('runContentWriterAgent', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('1. system prompt includes BASE + brand_voice + kevin_context + additional_context', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: 'a hook line',
        media_urls: [],
        reasoning_one_line: 'instagram-style hook',
      }),
    );
    const { runContentWriterAgent, CW_SYSTEM_BASE } = await import('../src/agent.js');
    await runContentWriterAgent(baseInput());
    const call = messagesCreate.mock.calls[0]?.[0] as {
      system: Array<{ text: string }>;
    };
    const joined = call.system.map((s) => s.text).join('\n');
    expect(joined).toContain(CW_SYSTEM_BASE.split('\n')[0]); // first line of base
    expect(joined).toContain('<brand_voice>');
    expect(joined).toContain('# voice body');
    expect(joined).toContain('Active deals');
    expect(joined).toContain('Damien at Almi');
  });

  it('2. user message wraps topic_text in <user_content> delimiters', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: 'a hook line',
        media_urls: [],
        reasoning_one_line: 'r',
      }),
    );
    const { runContentWriterAgent } = await import('../src/agent.js');
    await runContentWriterAgent(baseInput());
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = call.messages[0]?.content;
    expect(userPrompt).toMatch(/<user_content>/);
    expect(userPrompt).toMatch(/<\/user_content>/);
    expect(userPrompt).toContain('Tale Forge launched on App Store today');
  });

  it('3. platform-specific system suffix included (linkedin uses founder voice rule)', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: 'a long-ish linkedin post that satisfies length checks roughly',
        media_urls: [],
        reasoning_one_line: 'r',
      }),
    );
    const { runContentWriterAgent, PLATFORM_RULES } = await import('../src/agent.js');
    await runContentWriterAgent(baseInput({ platform: 'linkedin' }));
    const call = messagesCreate.mock.calls[0]?.[0] as {
      system: Array<{ text: string }>;
    };
    const joined = call.system.map((s) => s.text).join('\n');
    expect(joined).toContain(PLATFORM_RULES.linkedin);
    // Negative: instagram rule MUST NOT be smuggled into a linkedin prompt.
    expect(joined).not.toContain(PLATFORM_RULES.instagram);
  });

  it('4. invalid JSON output throws', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I am sorry; I cannot help with that' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { runContentWriterAgent } = await import('../src/agent.js');
    await expect(runContentWriterAgent(baseInput())).rejects.toThrow(
      /missing JSON|JSON\.parse/,
    );
  });

  it('5. media_urls defaults to [] when absent in Claude output', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: 'a hook',
        reasoning_one_line: 'short',
        // media_urls intentionally omitted
      }),
    );
    const { runContentWriterAgent } = await import('../src/agent.js');
    const r = await runContentWriterAgent(baseInput());
    expect(r.output.media_urls).toEqual([]);
  });

  it('6. instagram cap (2200) applied even when Sonnet returns longer content', async () => {
    const longContent = 'x'.repeat(5000);
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: longContent,
        media_urls: [],
        reasoning_one_line: 'cap test',
      }),
    );
    const { runContentWriterAgent } = await import('../src/agent.js');
    const r = await runContentWriterAgent(baseInput());
    expect(r.output.content.length).toBe(2200);
  });

  it('7. usage object captures input/output tokens', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput(
        {
          content: 'a hook',
          media_urls: [],
          reasoning_one_line: 'r',
        },
        { input_tokens: 1234, output_tokens: 567 },
      ),
    );
    const { runContentWriterAgent } = await import('../src/agent.js');
    const r = await runContentWriterAgent(baseInput());
    expect(r.usage.inputTokens).toBe(1234);
    expect(r.usage.outputTokens).toBe(567);
  });

  it('8. model id pinned to eu.anthropic.claude-sonnet-4-6', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockTextOutput({
        content: 'a hook',
        media_urls: [],
        reasoning_one_line: 'r',
      }),
    );
    const { runContentWriterAgent, SONNET_4_6_MODEL_ID } = await import('../src/agent.js');
    expect(SONNET_4_6_MODEL_ID).toBe('eu.anthropic.claude-sonnet-4-6');
    await runContentWriterAgent(baseInput());
    const call = messagesCreate.mock.calls[0]?.[0] as { model: string };
    expect(call.model).toBe('eu.anthropic.claude-sonnet-4-6');
  });
});
