/**
 * Phase 7 Plan 07-02 Task 1 — runDayCloseAgent unit tests.
 *
 * AnthropicBedrock is mocked. Verifies tool_use parsing for DayCloseBriefSchema,
 * safe-fallback on no-tool-use / Zod parse failure, and the system-prompt
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

import { runDayCloseAgent, __resetAgentClientForTests } from '../src/agent.js';

const A_UUID = '11111111-2222-4333-8444-555555555555';

const VALID_BRIEF = {
  prose_summary: 'Lugn dag. Tre saker rörde sig.',
  top_three: [
    { title: 'Damien · Almi follow-up (carryover)', entity_ids: [A_UUID], urgency: 'high' },
  ],
  dropped_threads: [],
  slipped_items: [
    { title: 'TaleForge investor reply', entity_ids: [A_UUID], reason: 'no email sent' },
  ],
  recent_decisions: ['Approved Almi convertible terms'],
  active_threads_delta: [
    { thread: 'TaleForge → Speed', status: 'updated' },
  ],
};

const baseInput = {
  kevinContextBlock: 'Kevin focus: Almi convertible loan',
  assembledMarkdown: '## Hot dossiers\nDamien Foulkes — Almi PM',
  hotEntitiesSummary: '- Damien (8 mentions)',
  slippedItemsHint: '- TaleForge investor reply (top 3 from morning, not acted)',
  decisionsHint: '- 09:32 Approved Almi convertible terms',
  stockholmDate: '2026-04-25',
  ownerId: 'owner-1',
};

describe('runDayCloseAgent', () => {
  beforeEach(() => {
    create.mockReset();
    __resetAgentClientForTests();
  });

  it('returns parsed DayCloseBrief on valid tool_use response', async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'record_day_close_brief', input: VALID_BRIEF },
      ],
      usage: { input_tokens: 1100, output_tokens: 600 },
    });
    const r = await runDayCloseAgent(baseInput);
    expect(r.output.prose_summary).toBe(VALID_BRIEF.prose_summary);
    expect(r.output.slipped_items).toHaveLength(1);
    expect(r.output.recent_decisions).toEqual(['Approved Almi convertible terms']);
    expect(r.output.active_threads_delta).toHaveLength(1);
    expect(r.usage.inputTokens).toBe(1100);
  });

  it('falls back to safe minimal brief on garbage Bedrock output', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Refused to call the tool' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = await runDayCloseAgent(baseInput);
    expect(r.output.top_three).toEqual([]);
    expect(r.output.slipped_items).toEqual([]);
    expect(r.output.recent_decisions).toEqual([]);
    expect(r.output.active_threads_delta).toEqual([]);
    expect(r.output.prose_summary).toMatch(/failed/i);
  });

  it('builds a system prompt of 3 segments each with cache_control:ephemeral', async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'record_day_close_brief', input: VALID_BRIEF },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    await runDayCloseAgent(baseInput);
    const callArgs = create.mock.calls[0]![0];
    const system = callArgs.system as Array<{ type: string; text: string; cache_control: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(3);
    for (const seg of system) {
      expect(seg.type).toBe('text');
      expect(seg.cache_control).toEqual({ type: 'ephemeral' });
    }
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'record_day_close_brief' });
    expect(callArgs.model).toMatch(/^eu\.anthropic\.claude-sonnet-4-6/);
  });
});
