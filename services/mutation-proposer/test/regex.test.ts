/**
 * Stage 1 regex tests (Plan 08-04 Task 1) — drives off the
 * IMPERATIVE_MUTATION_FIXTURES corpus from @kos/test-fixtures.
 */
import { describe, it, expect } from 'vitest';
import { IMPERATIVE_MUTATION_FIXTURES } from '@kos/test-fixtures';
import { detectImperative } from '../src/regex.js';

describe('detectImperative', () => {
  it('all positive fixtures match', () => {
    const positives = IMPERATIVE_MUTATION_FIXTURES.filter((f) => f.regex_should_match);
    for (const f of positives) {
      const result = detectImperative(f.input_text);
      expect(result.matched, `Expected match for "${f.input_text}"`).toBe(true);
      expect(result.matched_verb, `Expected verb for "${f.input_text}"`).not.toBeNull();
    }
  });

  it('all negative fixtures DO NOT match', () => {
    const negatives = IMPERATIVE_MUTATION_FIXTURES.filter((f) => !f.regex_should_match);
    for (const f of negatives) {
      const result = detectImperative(f.input_text);
      expect(result.matched, `Expected NO match for "${f.input_text}"`).toBe(false);
    }
  });

  it('Swedish: "ta bort mötet imorgon kl 11" → matched=true, lang=sv, verb=ta bort', () => {
    const r = detectImperative('ta bort mötet imorgon kl 11');
    expect(r.matched).toBe(true);
    expect(r.lang).toBe('sv');
    expect(r.matched_verb).toBe('ta bort');
  });

  it('English: "cancel the Damien call" → matched=true, lang=en, verb=cancel', () => {
    const r = detectImperative('cancel the Damien call');
    expect(r.matched).toBe(true);
    expect(r.lang).toBe('en');
    expect(r.matched_verb).toBe('cancel');
  });

  it('strips politeness prefix "please cancel tomorrow 11am"', () => {
    const r = detectImperative('please cancel tomorrow 11am');
    expect(r.matched).toBe(true);
    expect(r.lang).toBe('en');
    expect(r.matched_verb).toBe('cancel');
    expect(r.stripped_text.toLowerCase().startsWith('cancel')).toBe(true);
  });

  it('strips Swedish politeness "snälla ta bort mötet"', () => {
    const r = detectImperative('snälla ta bort mötet');
    expect(r.matched).toBe(true);
    expect(r.lang).toBe('sv');
    expect(r.matched_verb).toBe('ta bort');
    expect(r.stripped_text.toLowerCase().startsWith('ta bort')).toBe(true);
  });

  it('case-insensitive ("TA BORT" + "Cancel")', () => {
    expect(detectImperative('TA BORT mötet').matched).toBe(true);
    expect(detectImperative('Cancel the meeting').matched).toBe(true);
  });

  it('leading whitespace tolerated', () => {
    const r = detectImperative('   cancel the meeting');
    expect(r.matched).toBe(true);
    expect(r.matched_verb).toBe('cancel');
  });
});
