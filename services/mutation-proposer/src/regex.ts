/**
 * Stage 1 of the AGT-08 imperative-verb mutation pipeline (Plan 08-04).
 *
 * Cheap regex pre-filter that decides whether a capture text COULD be an
 * imperative mutation request — this is intentionally lossy on the
 * positive side (false positives are caught by the Haiku stage) and tight
 * on the negative side (false negatives are silently dropped, so we err
 * toward false positives).
 *
 * Bilingual coverage:
 *   - Swedish: ta bort / avboka / flytta / skjut / ändra / stryk / radera
 *              / arkivera / sluta / skippa
 *   - English: cancel / delete / remove / drop / archive / reschedule /
 *              move / postpone / clear / skip
 *
 * Politeness prefixes ("snälla", "kan du", "please", "can you", ...) are
 * stripped before the verb match so "please cancel tomorrow 11am" routes
 * the same as "cancel tomorrow 11am".
 *
 * Negative patterns explicitly NOT matched by the regex:
 *   - 1st-person declarative: "jag måste avboka mötet" (Kevin reports an
 *     intent — voice-capture writes the task instead)
 *   - Past tense: "I canceled the meeting"
 *   - Questions: "should we cancel the Damien call?"
 *
 * Reference: packages/test-fixtures/src/imperative-mutations.ts (Plan 08-00
 * Task 5) — IMPERATIVE_MUTATION_FIXTURES carries the canonical 17-row
 * positive/negative test corpus this regex must satisfy.
 */

const SV_VERB_GROUP =
  '(ta bort|avboka|flytta|skjut(?:a|t|it)?|ändra|stryk(?:a)?|radera|arkivera|slut(?:a|ta|tat)?|skippa)';
const EN_VERB_GROUP =
  '(cancel|delete|remove|drop|archive|reschedule|move|postpone|clear|skip)';

// Politeness prefixes — stripped at the START of the input string only.
// We DO NOT strip mid-string politeness because "Kevin said please cancel"
// is unsafe to treat as an imperative without LLM confirmation anyway.
const SV_POLITENESS = /^\s*(?:snälla|kan du|vill du|skulle du kunna)\s+/i;
const EN_POLITENESS = /^\s*(?:please|can you|could you|would you)\s+/i;

// The leading-verb match: the imperative starts with the verb (after
// politeness stripping + whitespace). Anchoring to ^ keeps "I canceled X"
// out of the positive set (the verb is not in the imperative position).
const SV_LEADING = new RegExp(`^\\s*${SV_VERB_GROUP}\\b`, 'i');
const EN_LEADING = new RegExp(`^\\s*${EN_VERB_GROUP}\\b`, 'i');

export interface ImperativeMatch {
  /** Did the regex fire? */
  matched: boolean;
  /** Politeness-stripped text (lowercased preserved). */
  stripped_text: string;
  /** The matched verb in lowercase, or null. */
  matched_verb: string | null;
  /** Detected language. 'unknown' when no match. */
  lang: 'sv' | 'en' | 'unknown';
}

export function detectImperative(text: string): ImperativeMatch {
  // Try Swedish first — politeness strip → verb match.
  const svStripped = text.replace(SV_POLITENESS, '');
  const svMatch = svStripped.match(SV_LEADING);
  if (svMatch && svMatch[1]) {
    return {
      matched: true,
      stripped_text: svStripped.trim(),
      matched_verb: svMatch[1].toLowerCase(),
      lang: 'sv',
    };
  }

  // Then English.
  const enStripped = text.replace(EN_POLITENESS, '');
  const enMatch = enStripped.match(EN_LEADING);
  if (enMatch && enMatch[1]) {
    return {
      matched: true,
      stripped_text: enStripped.trim(),
      matched_verb: enMatch[1].toLowerCase(),
      lang: 'en',
    };
  }

  return { matched: false, stripped_text: text, matched_verb: null, lang: 'unknown' };
}
