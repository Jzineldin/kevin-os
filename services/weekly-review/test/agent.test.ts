/**
 * Phase 7 Plan 07-02 Task 2 — runWeeklyReviewAgent unit tests.
 *
 * AnthropicBedrock is mocked. Verifies tool_use parsing for WeeklyReviewSchema,
 * safe-fallback on garbage Bedrock output, and that WeeklyReviewSchema does
 * NOT include top_three (D-05 schema-conformance).
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

import { runWeeklyReviewAgent, __resetAgentClientForTests } from '../src/agent.js';
import { WeeklyReviewSchema } from '@kos/contracts';

const VALID_REVIEW = {
  prose_summary:
    'En produktiv vecka. Almi-kontraktet skickat. TaleForge nådde 1k DAU. Tre möten med investerare bokade nästa vecka.',
  week_recap: [
    'Almi convertible signerat fredag',
    'TaleForge MAU passerade 5k',
    'Speed Q2 roadmap låst',
  ],
  next_week_candidates: [
    { title: 'Outbehaving demo', why: 'investor pitch klar mån' },
    { title: 'Tale Forge release notes', why: 'iOS 1.4 skeppar tor' },
  ],
  active_threads_snapshot: [
    { thread: 'Almi convertible', where: 'almi', status: 'signed' },
    { thread: 'Speed Q2 roadmap', where: 'speed', status: 'locked' },
  ],
};

const baseInput = {
  kevinContextBlock: 'Kevin focus: closing Q2',
  assembledMarkdown: '## Hot dossiers (last 7 days)\nDamien — Almi PM',
  weekRecapHint:
    '- mentions: 142\n- emails: 87\n- morning_briefs: 5\n- day_closes: 5',
  activeThreadsHint:
    '- Almi convertible (almi) · in-progress\n- TaleForge release (tale-forge) · in-progress',
  weekStartStockholm: '2026-04-19',
  weekEndStockholm: '2026-04-25',
  ownerId: 'owner-1',
};

describe('runWeeklyReviewAgent', () => {
  beforeEach(() => {
    create.mockReset();
    __resetAgentClientForTests();
  });

  it('returns parsed WeeklyReview on valid tool_use response', async () => {
    create.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'record_weekly_review', input: VALID_REVIEW },
      ],
      usage: { input_tokens: 1500, output_tokens: 700 },
    });
    const r = await runWeeklyReviewAgent(baseInput);
    expect(r.output.prose_summary).toBe(VALID_REVIEW.prose_summary);
    expect(r.output.week_recap).toHaveLength(3);
    expect(r.output.next_week_candidates).toHaveLength(2);
    expect(r.output.active_threads_snapshot).toHaveLength(2);
    expect(r.usage.inputTokens).toBe(1500);
  });

  it('falls back to safe minimal review on garbage Bedrock output', async () => {
    create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Refused to call the tool' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = await runWeeklyReviewAgent(baseInput);
    expect(r.output.week_recap).toEqual([]);
    expect(r.output.next_week_candidates).toEqual([]);
    expect(r.output.active_threads_snapshot).toEqual([]);
    expect(r.output.prose_summary).toMatch(/failed/i);
  });

  it('schema-conformance: WeeklyReviewSchema does NOT include top_three field', () => {
    // D-05 + Plan 07-02 Task 2 acceptance: WeeklyReview has no Top 3.
    const valid = WeeklyReviewSchema.safeParse(VALID_REVIEW);
    expect(valid.success).toBe(true);
    const shape = WeeklyReviewSchema.shape;
    expect(shape).not.toHaveProperty('top_three');
    expect(shape).not.toHaveProperty('dropped_threads');
    expect(shape).toHaveProperty('week_recap');
    expect(shape).toHaveProperty('next_week_candidates');
    expect(shape).toHaveProperty('active_threads_snapshot');
  });
});
