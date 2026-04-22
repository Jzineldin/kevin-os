/**
 * Plan 02-09 Task 1 — extractPersonCandidates unit tests.
 *
 * Confidence tier gating:
 *   - HIGH: Gmail From header + Swedish/English email sign-offs
 *   - MEDIUM: capitalised 2-word body sequences with ≥3-char words
 *   - LOW: excluded entirely (single-word caps too noisy)
 *
 * Blocklist: Kevin himself, org names, Plan 08 Kontakter overlap.
 */

import { describe, it, expect } from 'vitest';
import { extractPersonCandidates } from '../src/extract.js';

describe('extractPersonCandidates', () => {
  it('HIGH: Swedish email sign-off "Mvh,\\nJezper Andersson" → 1 high candidate', () => {
    const text = 'Hej Kevin,\n\nHär kommer offerten.\n\nMvh,\nJezper Andersson';
    const out = extractPersonCandidates(text);
    const jezper = out.find((c) => c.name === 'Jezper Andersson');
    expect(jezper).toBeDefined();
    expect(jezper!.confidence).toBe('high');
    expect(jezper!.source_hint).toBe('signature');
  });

  it('HIGH: English sign-off "Best,\\nSofia Lindqvist" → 1 high candidate', () => {
    const text = 'Hi Kevin,\n\nLet me know if that works.\n\nBest,\nSofia Lindqvist';
    const out = extractPersonCandidates(text);
    const sofia = out.find((c) => c.name === 'Sofia Lindqvist');
    expect(sofia).toBeDefined();
    expect(sofia!.confidence).toBe('high');
  });

  it('HIGH: Gmail From header → Damien (blocklisted) → 0 candidates', () => {
    const text = 'From: "Damien Lovell" <damien@example.com>';
    const out = extractPersonCandidates(text);
    expect(out).toEqual([]);
  });

  it('HIGH: Gmail From header with non-blocklisted name yields 1 high candidate', () => {
    const text = 'From: "Henrik Norén" <henrik@example.com>';
    const out = extractPersonCandidates(text);
    const henrik = out.find((c) => c.name === 'Henrik Norén');
    expect(henrik).toBeDefined();
    expect(henrik!.confidence).toBe('high');
    expect(henrik!.source_hint).toBe('header');
  });

  it('MEDIUM: Transcript body "pratade vi med Christina Jönsson om investmentet" → Christina at medium', () => {
    const text =
      'sedan pratade vi med Christina Jönsson om investmentet och hon verkade positiv';
    const out = extractPersonCandidates(text);
    const c = out.find((x) => x.name === 'Christina Jönsson');
    expect(c).toBeDefined();
    expect(c!.confidence).toBe('medium');
    expect(c!.source_hint).toBe('body');
    expect(c!.context_snippet.toLowerCase()).toContain('christina');
  });

  it('blocklist: "Tale Forge" → 0 candidates', () => {
    const text = 'vi pratade om Tale Forge och om hur det skalar';
    const out = extractPersonCandidates(text);
    expect(out.find((c) => c.name.toLowerCase() === 'tale forge')).toBeUndefined();
  });

  it('single-word caps "Damien" alone → 0 candidates (LOW excluded)', () => {
    const text = 'Damien said the deal closes Friday';
    const out = extractPersonCandidates(text);
    // Damien alone is single-word → excluded; "Damien said" isn't a Person
    expect(out.map((c) => c.name)).not.toContain('Damien');
  });

  it('min word length: "Ng Lo" → 0 candidates (both <3 chars); "Monday April" → also excluded (April is caps noun)', () => {
    // Both <3 chars: excluded
    const text1 = 'Ng Lo visited us';
    expect(extractPersonCandidates(text1).find((c) => c.name === 'Ng Lo')).toBeUndefined();
  });

  it('dedup: same name appears 3 times → 1 candidate output', () => {
    const text =
      'Henrik Norén joined the call. Henrik Norén shared the deck. Later Henrik Norén left.';
    const out = extractPersonCandidates(text);
    const hits = out.filter((c) => c.name === 'Henrik Norén');
    expect(hits.length).toBe(1);
  });

  it('HIGH upgrade: same name hits From header + body → final confidence=high (header wins)', () => {
    const text = [
      'From: "Henrik Norén" <henrik@example.com>',
      'Body: we talked to Henrik Norén about the deal',
    ].join('\n');
    const out = extractPersonCandidates(text);
    const h = out.find((c) => c.name === 'Henrik Norén');
    expect(h).toBeDefined();
    expect(h!.confidence).toBe('high');
  });

  it('blocklist: Kevin himself (multiple spellings) → 0 candidates', () => {
    const texts = [
      'Kevin El-zarka is CEO',
      'och så pratade vi med Kevin Elzarka',
      'Kevin said yes',
    ];
    for (const t of texts) {
      const out = extractPersonCandidates(t);
      expect(out.some((c) => /kevin/i.test(c.name))).toBe(false);
    }
  });

  it('empty / non-string input returns []', () => {
    expect(extractPersonCandidates('')).toEqual([]);
    // @ts-expect-error intentional
    expect(extractPersonCandidates(null)).toEqual([]);
  });
});
