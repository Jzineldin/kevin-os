/**
 * Phase 7 Plan 07-01 Task 2 — runMorningBriefAgent unit tests.
 *
 * AnthropicBedrock is mocked. Verifies tool_use parsing, safe-fallback on
 * no-tool-use, safe-fallback on Zod parse failure, and the system-prompt
 * cache_control segments.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const create = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  return {
    default: class AnthropicBedrock {
      messages = { create };
    },
  };
});

import { runMorningBriefAgent, __resetAgentClientForTests } from '../src/agent.js';

const A_UUID = '11111111-2222-4333-8444-555555555555';

const VALID_BRIEF = {
  prose_summary: 'Lugn morgon. Top 3 åtgärder.',
  top_three: [
    { title: 'Damien · Almi follow-up', entity_ids: [A_UUID], urgency: 'high' },
  ],
  dropped_threads: [],
  calendar_today: [],
  calendar_tomorrow: [],
  drafts_ready: [],
};

const baseInput = {
  kevinContextBlock: 'Kevin focus: Almi convertible loan + Tale Forge growth',
  assembledMarkdown: '## Hot dossiers\nDamien Foulkes — Almi PM',
  hotEntitiesSummary: '- Damien (12 mentions)',
  draftsReadySummary: '(no drafts awaiting approval)',
  calendarHint: '(Calendar integration pending Phase 8)',
  stockholmDate: '2026-04-25',
  ownerId: 'owner-1',
};

describe('runMorningBriefAgent', () => {
  beforeEach(() => {
    create.mockReset();
    __resetAgentClientForTests();
  });

  it('returns parsed MorningBrief on valid tool_use response', async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'record_morning_brief', input: VALID_BRIEF },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const r = await runMorningBriefAgent(baseInput);
    expect(r.output.prose_summary).toBe(VALID_BRIEF.prose_summary);
    expect(r.output.top_three).toHaveLength(1);
    expect(r.usage.inputTokens).toBe(1000);
  });

  it('falls back to safe minimal brief when Bedrock returns no tool_use block', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Refused to call the tool' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = await runMorningBriefAgent(baseInput);
    expect(r.output.top_three).toEqual([]);
    expect(r.output.dropped_threads).toEqual([]);
    expect(r.output.prose_summary).toMatch(/failed/i);
  });

  it('falls back to safe minimal brief when Zod parse rejects tool input', async () => {
    create.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'record_morning_brief',
          input: { not: 'a brief shape', invalid: true },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = await runMorningBriefAgent(baseInput);
    expect(r.output.top_three).toEqual([]);
    expect(r.output.prose_summary).toMatch(/failed/i);
  });

  it('builds a system prompt of 3 segments each with cache_control:ephemeral', async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'record_morning_brief', input: VALID_BRIEF },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    await runMorningBriefAgent(baseInput);
    const callArgs = create.mock.calls[0][0];
    const system = callArgs.system as Array<{ type: string; text: string; cache_control: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(3);
    for (const seg of system) {
      expect(seg.type).toBe('text');
      expect(seg.cache_control).toEqual({ type: 'ephemeral' });
    }
    // Force tool_choice on record_morning_brief.
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'record_morning_brief' });
    expect(callArgs.model).toMatch(/^eu\.anthropic\.claude-sonnet-4-6/);
  });
});
