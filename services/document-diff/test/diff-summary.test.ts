/**
 * diff-summary.test.ts — Plan 08-05 Task 1 (5 tests).
 *
 *   1. Calls AnthropicBedrock Haiku 4.5 with prior + current in delimited blocks
 *   2. Both texts in Swedish → system prompt instructs Swedish output
 *   3. Truncates each side to 2000 chars (RESEARCH P-6)
 *   4. Trivial change → Haiku returns 'trivial' (or contains it) — confirmed
 *      via fixture pair from @kos/test-fixtures/document-diff-pairs
 *   5. Material change → Haiku returns text containing the new clause
 *
 * Bedrock SDK is mocked at the module level so we control the messages.create
 * input/output without making real Bedrock calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DOCUMENT_DIFF_PAIRS } from '@kos/test-fixtures';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  })),
}));

import {
  generateDiffSummary,
  detectLang,
  PER_VERSION_CHAR_CAP,
  HAIKU_4_5_MODEL_ID,
} from '../src/diff-summary.js';

function mockText(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 200, output_tokens: 50 },
  };
}

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.AWS_REGION = 'eu-north-1';
});

describe('generateDiffSummary', () => {
  it('1. calls Haiku 4.5 with prior + current in delimited blocks', async () => {
    messagesCreate.mockResolvedValueOnce(mockText('A new clause was added.'));
    const out = await generateDiffSummary({
      priorText: 'foo',
      currentText: 'foo + new line',
      docName: 'avtal.pdf',
      recipient: 'damien@almi.se',
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const call = messagesCreate.mock.calls[0]?.[0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.model).toBe(HAIKU_4_5_MODEL_ID);
    expect(call.messages[0]!.content).toContain('<previous_version>');
    expect(call.messages[0]!.content).toContain('</previous_version>');
    expect(call.messages[0]!.content).toContain('<current_version>');
    expect(call.messages[0]!.content).toContain('</current_version>');
    expect(call.messages[0]!.content).toContain('foo');
    expect(call.messages[0]!.content).toContain('foo + new line');
    expect(out).toBe('A new clause was added.');
  });

  it('2. Swedish input → system prompt instructs Swedish output', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockText('En ny klausul (4.2) lades till om ESOP-allokering.'),
    );
    const swedishPair = DOCUMENT_DIFF_PAIRS.find(
      (p) => p.name === 'avtal_v3_to_v4_esop_clause_added',
    )!;
    await generateDiffSummary({
      priorText: swedishPair.prior_text,
      currentText: swedishPair.current_text,
      docName: 'avtal.pdf',
      recipient: 'damien@almi.se',
    });
    const call = messagesCreate.mock.calls[0]?.[0] as {
      system: Array<{ text: string }> | string;
    };
    const systemText = Array.isArray(call.system)
      ? call.system.map((s) => s.text).join('\n')
      : (call.system as unknown as string);
    expect(systemText).toMatch(/svenska|Swedish/i);
    // Sanity: the Swedish detector picks 'sv' for the fixture pair.
    expect(detectLang(swedishPair.current_text)).toBe('sv');
  });

  it('3. Truncates each side to 2000 chars (RESEARCH P-6)', async () => {
    messagesCreate.mockResolvedValueOnce(mockText('summary'));
    const big = 'A'.repeat(5000);
    await generateDiffSummary({
      priorText: big,
      currentText: big + 'B'.repeat(100),
      docName: 'big.pdf',
      recipient: 'a@b.com',
    });
    const call = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    const userContent = call.messages[0]!.content;
    // Each block carries at most PER_VERSION_CHAR_CAP characters of the
    // huge input. We assert the total user-content size is well below
    // 2 * (block_overhead + 2000) — i.e. nowhere near 10 000 chars.
    expect(userContent.length).toBeLessThan(2 * PER_VERSION_CHAR_CAP + 500);
    // And each block contains at most 2000 'A' characters (no leakage past cap).
    const priorBlock = userContent.match(/<previous_version>([\s\S]*?)<\/previous_version>/);
    expect(priorBlock).not.toBeNull();
    expect(priorBlock![1]!.replace(/\s/g, '').length).toBeLessThanOrEqual(
      PER_VERSION_CHAR_CAP,
    );
  });

  it('4. Trivial change → Haiku returns "trivial" (fixture-aligned)', async () => {
    messagesCreate.mockResolvedValueOnce(mockText('trivial'));
    const trivialPair = DOCUMENT_DIFF_PAIRS.find(
      (p) => p.name === 'avtal_v4_to_v5_formatting_only',
    )!;
    const out = await generateDiffSummary({
      priorText: trivialPair.prior_text,
      currentText: trivialPair.current_text,
      docName: 'avtal.pdf',
      recipient: 'damien@almi.se',
    });
    expect(out.toLowerCase()).toContain('trivial');
  });

  it('5. Material change → Haiku returns text containing the new clause content', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockText(
        'Investment amount changed from 1,000,000 SEK to 1,500,000 SEK in the current version.',
      ),
    );
    const numPair = DOCUMENT_DIFF_PAIRS.find(
      (p) => p.name === 'english_number_change',
    )!;
    const out = await generateDiffSummary({
      priorText: numPair.prior_text,
      currentText: numPair.current_text,
      docName: 'term_sheet.docx',
      recipient: 'damien@almi.se',
    });
    // Soft assertion: the response should mention at least one of the
    // expected tokens from the fixture's expected_summary_contains array.
    const matches = numPair.expected_summary_contains.some((tok) =>
      out.includes(tok),
    );
    expect(matches).toBe(true);
  });
});

describe('detectLang', () => {
  it('returns sv for Swedish-heavy text', () => {
    expect(detectLang('Kapitel 4: Vesting och allokering för aktier')).toBe('sv');
  });
  it('returns en for English-heavy text', () => {
    expect(detectLang('Investment amount and the section clause of section 4')).toBe(
      'en',
    );
  });
});
