/**
 * agent.test.ts — runExtractorAgent unit tests (Plan 06-02 Task 1).
 *
 * Coverage:
 *   1. Happy path: tool_use returns valid Extract.
 *   2. Graceful degrade on Zod validation failure (malformed input).
 *   3. Ignores text blocks alongside tool_use (chain-of-thought leakage —
 *      RESEARCH §8 pitfall B / T-06-EXTRACTOR-03).
 *   4. System prompt has cache_control: ephemeral on every text segment.
 *   5. tool_choice forces the record_transcript_extract tool.
 *   6. No tool_use block at all → graceful degrade (degraded=true, empty extract).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every messages.create call payload for inspection.
const createSpy = vi.fn();
const createImpl = vi.fn();

vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: (input: unknown) => {
        createSpy(input);
        return createImpl(input);
      },
    },
  })),
}));

beforeEach(async () => {
  createSpy.mockClear();
  createImpl.mockReset();
  process.env.AWS_REGION = 'eu-north-1';
  // Reset the singleton client so the mocked AnthropicBedrock constructor
  // is hit on each test rather than the module-cached instance.
  const { __resetClientForTests } = await import('../src/agent.js');
  __resetClientForTests();
});

const validToolInput = {
  action_items: [
    {
      title: 'Ping Damien om konvertibellånet',
      priority: 'high' as const,
      due_hint: 'innan fredag',
      linked_entity_ids: [],
      source_excerpt: 'Kevin sa att han skulle pinga Damien om konvertibellånet.',
    },
  ],
  mentioned_entities: [
    {
      name: 'Damien',
      type: 'Person' as const,
      aliases: ['Damien J.'],
      sentiment: 'neutral' as const,
      occurrence_count: 3,
      excerpt: 'Damien diskuterade konvertibellånet med Kevin.',
    },
  ],
  summary: 'Kevin och Damien diskuterade Almi konvertibellånet inför fredagens möte.',
  decisions: [],
  open_questions: [],
};

describe('runExtractorAgent', () => {
  it('happy path: tool_use returns a valid Extract', async () => {
    createImpl.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'record_transcript_extract', input: validToolInput }],
      usage: { input_tokens: 1500, output_tokens: 280 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    const result = await runExtractorAgent({
      transcriptText: 'Möte om konvertibellånet med Damien.',
      title: 'Almi follow-up',
      contextBlock: '## Kevin Context\nFounder of Tale Forge.',
    });

    expect(result.degraded).toBe(false);
    expect(result.extract.action_items).toHaveLength(1);
    expect(result.extract.mentioned_entities).toHaveLength(1);
    expect(result.extract.action_items[0]!.priority).toBe('high');
    expect(result.usage.inputTokens).toBe(1500);
    expect(result.usage.outputTokens).toBe(280);
  });

  it('graceful degrade on Zod validation failure (malformed tool input)', async () => {
    createImpl.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'record_transcript_extract',
          input: {
            // Missing required fields + wrong priority enum.
            action_items: [{ title: 'x', priority: 'URGENT', source_excerpt: 'x' }],
            mentioned_entities: [],
            // missing summary entirely
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    const result = await runExtractorAgent({
      transcriptText: 'x',
      title: 't',
      contextBlock: '',
    });

    expect(result.degraded).toBe(true);
    expect(result.extract.action_items).toHaveLength(0);
    expect(result.extract.mentioned_entities).toHaveLength(0);
    expect(result.extract.summary).toBe('');
    // rawToolInput is preserved for prompt iteration / debugging.
    expect(result.rawToolInput).toBeDefined();
  });

  it('ignores text blocks alongside tool_use (chain-of-thought leakage mitigation)', async () => {
    createImpl.mockResolvedValue({
      content: [
        { type: 'text', text: "Let me think about this... I'll extract..." },
        { type: 'tool_use', name: 'record_transcript_extract', input: validToolInput },
      ],
      usage: { input_tokens: 800, output_tokens: 200 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    const result = await runExtractorAgent({
      transcriptText: 'x',
      title: 't',
      contextBlock: '',
    });

    expect(result.degraded).toBe(false);
    expect(result.extract.action_items).toHaveLength(1);
    // The raw tool_use input was consumed; the text block did NOT leak in.
    expect(result.extract.summary).toContain('Almi');
  });

  it('system prompt has cache_control: ephemeral on every text segment', async () => {
    createImpl.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'record_transcript_extract', input: validToolInput }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    await runExtractorAgent({
      transcriptText: 'x',
      title: 't',
      contextBlock: '## Some context\nbody text',
    });

    const callArgs = createSpy.mock.calls[0]![0] as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    };
    expect(Array.isArray(callArgs.system)).toBe(true);
    // Two segments expected (BASE prompt + context block).
    expect(callArgs.system).toHaveLength(2);
    for (const seg of callArgs.system) {
      expect(seg.type).toBe('text');
      expect(seg.cache_control).toEqual({ type: 'ephemeral' });
      expect(typeof seg.text).toBe('string');
      expect(seg.text.length).toBeGreaterThan(0);
    }
  });

  it('tool_choice forces the record_transcript_extract tool', async () => {
    createImpl.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'record_transcript_extract', input: validToolInput }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    await runExtractorAgent({
      transcriptText: 'x',
      title: 't',
      contextBlock: '',
    });

    const callArgs = createSpy.mock.calls[0]![0] as {
      tool_choice?: { type: string; name: string };
      tools?: Array<{ name: string }>;
      model: string;
    };
    expect(callArgs.tool_choice).toEqual({
      type: 'tool',
      name: 'record_transcript_extract',
    });
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools![0]!.name).toBe('record_transcript_extract');
    // Sonnet 4.6 EU CRIS profile per CONTEXT D-06.
    expect(callArgs.model).toMatch(/sonnet-4-6/);
  });

  it('no tool_use block → graceful degrade (degraded=true, empty extract)', async () => {
    createImpl.mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot extract this.' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const { runExtractorAgent } = await import('../src/agent.js');
    const result = await runExtractorAgent({
      transcriptText: 'x',
      title: 't',
      contextBlock: '',
    });
    expect(result.degraded).toBe(true);
    expect(result.extract.action_items).toHaveLength(0);
    expect(result.extract.mentioned_entities).toHaveLength(0);
    expect(result.rawToolInput).toBeNull();
  });
});
