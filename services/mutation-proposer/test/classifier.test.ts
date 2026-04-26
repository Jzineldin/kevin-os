/**
 * Stage 2 + 3 classifier tests (Plan 08-04 Task 1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  })),
}));

function mockJsonResponse(obj: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

describe('classifyMutation (Haiku 4.5)', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('parses Haiku JSON output cleanly when classified as cancel_meeting', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        is_mutation: true,
        mutation_type: 'cancel_meeting',
        confidence: 0.92,
        reasoning: 'imperative cancel of upcoming meeting',
      }),
    );
    const { classifyMutation } = await import('../src/classifier.js');
    const r = await classifyMutation('ta bort mötet imorgon kl 11', '## Kevin Context\nx');
    expect(r.is_mutation).toBe(true);
    expect(r.mutation_type).toBe('cancel_meeting');
    expect(r.confidence).toBeCloseTo(0.92);
  });

  it('Haiku is_mutation=false (regex false-positive) parsed cleanly', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        is_mutation: false,
        mutation_type: 'none',
        confidence: 0.95,
        reasoning: 'subscription cancellation, out of KOS domain',
      }),
    );
    const { classifyMutation } = await import('../src/classifier.js');
    const r = await classifyMutation('cancel the subscription', '');
    expect(r.is_mutation).toBe(false);
  });

  it('user_content wrapping tag is present in the prompt', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        is_mutation: false,
        mutation_type: 'none',
        confidence: 0.5,
        reasoning: 'x',
      }),
    );
    const { classifyMutation } = await import('../src/classifier.js');
    await classifyMutation('cancel the meeting', '## Kevin\nx');
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0]?.content).toMatch(/<user_content>/);
    expect(call.messages[0]?.content).toMatch(/<\/user_content>/);
  });

  it('Haiku model id pinned + cache_control:ephemeral on populated segments', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        is_mutation: false,
        mutation_type: 'none',
        confidence: 0.5,
        reasoning: 'x',
      }),
    );
    const { classifyMutation, HAIKU_4_5_MODEL_ID } = await import('../src/classifier.js');
    expect(HAIKU_4_5_MODEL_ID).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    await classifyMutation('cancel the meeting', '## Kevin\nx');
    const call = messagesCreate.mock.calls[0]?.[0] as {
      model: string;
      system: Array<{ cache_control?: { type: string } }>;
    };
    expect(call.model).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
    // BASE + Kevin Context = 2 segments, both ephemeral
    expect(call.system).toHaveLength(2);
    for (const seg of call.system) {
      expect(seg.cache_control?.type).toBe('ephemeral');
    }
  });

  it('non-JSON Haiku output → safe fallback (is_mutation=false)', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sorry, no JSON for you' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { classifyMutation } = await import('../src/classifier.js');
    const r = await classifyMutation('cancel the meeting', '');
    expect(r.is_mutation).toBe(false);
    expect(r.mutation_type).toBe('none');
    expect(r.reasoning).toContain('haiku_no_json');
  });
});

describe('decideTarget (Sonnet 4.6)', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('selected_target returned when confidence >= 0.8', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        selected_target: {
          kind: 'meeting',
          id: 'evt-1',
          display: 'Damien call @ 11:00',
          confidence: 0.92,
        },
        alternatives: [],
        reasoning: 'explicit reference Damien',
      }),
    );
    const { decideTarget } = await import('../src/classifier.js');
    const r = await decideTarget({
      text: 'cancel the Damien call',
      haikuResult: {
        is_mutation: true,
        mutation_type: 'cancel_meeting',
        confidence: 0.9,
        reasoning: '',
      },
      kevinContext: '',
      additionalContext: '',
      candidates: [
        { kind: 'meeting', id: 'evt-1', display: 'Damien call @ 11:00' },
        { kind: 'meeting', id: 'evt-2', display: 'Standup @ 11:00' },
      ],
    });
    expect(r.selected_target).not.toBeNull();
    expect(r.selected_target?.id).toBe('evt-1');
    expect(r.alternatives).toEqual([]);
  });

  it('alternatives surfaced when no single target ≥ 0.8', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({
        selected_target: null,
        alternatives: [
          { kind: 'meeting', id: 'evt-1', display: 'Standup @ 11:00', confidence: 0.7 },
          { kind: 'meeting', id: 'evt-2', display: 'Investor sync @ 11:00', confidence: 0.65 },
        ],
        reasoning: 'ambiguous timestamp',
      }),
    );
    const { decideTarget } = await import('../src/classifier.js');
    const r = await decideTarget({
      text: 'ta bort mötet imorgon kl 11',
      haikuResult: {
        is_mutation: true,
        mutation_type: 'cancel_meeting',
        confidence: 0.9,
        reasoning: '',
      },
      kevinContext: '',
      additionalContext: '',
      candidates: [
        { kind: 'meeting', id: 'evt-1', display: 'Standup @ 11:00' },
        { kind: 'meeting', id: 'evt-2', display: 'Investor sync @ 11:00' },
      ],
    });
    expect(r.selected_target).toBeNull();
    expect(r.alternatives).toHaveLength(2);
  });

  it('candidates list rendered into the prompt', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({ selected_target: null, alternatives: [], reasoning: 'x' }),
    );
    const { decideTarget } = await import('../src/classifier.js');
    await decideTarget({
      text: 'cancel x',
      haikuResult: {
        is_mutation: true,
        mutation_type: 'cancel_meeting',
        confidence: 0.9,
        reasoning: '',
      },
      kevinContext: '',
      additionalContext: '',
      candidates: [{ kind: 'meeting', id: 'evt-1', display: 'Damien call' }],
    });
    const call = messagesCreate.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    expect(call.messages[0]?.content).toMatch(/\[meeting:evt-1\]/);
    expect(call.messages[0]?.content).toMatch(/Damien call/);
  });

  it('Sonnet model id pinned to eu.anthropic.claude-sonnet-4-6', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockJsonResponse({ selected_target: null, alternatives: [], reasoning: 'x' }),
    );
    const { decideTarget, SONNET_4_6_MODEL_ID } = await import('../src/classifier.js');
    expect(SONNET_4_6_MODEL_ID).toBe('eu.anthropic.claude-sonnet-4-6');
    await decideTarget({
      text: 'x',
      haikuResult: {
        is_mutation: true,
        mutation_type: 'cancel_meeting',
        confidence: 0.9,
        reasoning: '',
      },
      kevinContext: '',
      additionalContext: '',
      candidates: [],
    });
    const call = messagesCreate.mock.calls[0]?.[0] as { model: string };
    expect(call.model).toBe('eu.anthropic.claude-sonnet-4-6');
  });
});
