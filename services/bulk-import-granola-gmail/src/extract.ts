/**
 * Person-mention extractor for bulk-import-granola-gmail (Plan 02-09 / ENT-06).
 *
 * Two confidence tiers (LOW excluded — too noisy in 90-day bulk):
 *
 *   HIGH: Gmail `From: "First Last" <addr>` headers OR Swedish/English email
 *         sign-offs ("Mvh, Jezper Andersson" / "Best,\nDamien Lovell" /
 *         "Vänligen,\nChristina Jönsson"). These are essentially canonical
 *         Person identities.
 *
 *   MEDIUM: Capitalised two-word sequences in Transkripten body text
 *           ("Christina Jönsson", "Henrik Norén"). Filtered by min word
 *           length (≥3) to skip noise like "Ping Damien" / "Monday April".
 *
 * Per-text dedup uses a Map keyed by lowercased name; HIGH wins over MEDIUM
 * if both confidences hit the same name. Cross-source dedup happens in the
 * handler via a shared seen-Set (Pitfall 8).
 *
 * Blocklist: Kevin himself (multiple spellings), org names that aren't
 * People, common Swedish words that match the 2-word capitalised regex.
 */

export interface PersonCandidate {
  name: string;
  context_snippet: string;
  confidence: 'high' | 'medium' | 'low';
  source_hint: 'signature' | 'header' | 'body';
}

const BLOCKLIST = new Set<string>([
  // Kevin himself
  'kevin el-zarka',
  'kevin elzarka',
  'kevin el zarka',
  'kevin',
  // Companies / products / services
  'tale forge',
  'tale forge ab',
  'outbehaving',
  'kos',
  'kevin os',
  'notion',
  'google',
  'aws',
  'slack',
  'bedrock',
  'anthropic',
  'openai',
  'azure',
  'vercel',
  // Already in Kontakter (Plan 08) — extractor can still surface these but
  // dedup will skip; keeping in blocklist eliminates the wasted dedup hit.
  'damien lovell',
  // Swedish common multi-word phrases that look like Names but aren't
  'tack snälla',
  'tack tack',
]);

/**
 * Per-word blocklist: if EITHER word in a 2-word match is in this set, the
 * pair is rejected. Catches sentence-start words ("Sedan" / "Också" / "När")
 * + "First-word + Kevin" pairs (Tjena Kevin / Också Kevin).
 *
 * Also includes common org names so "Almi Sedan" (Almi org + sentence-start)
 * gets vetoed.
 */
const WORD_BLOCKLIST = new Set<string>([
  // Kevin (always)
  'kevin',
  // Common Swedish/English sentence-start capitalised words
  'sedan',
  'också',
  'och',
  'när',
  'där',
  'här',
  'idag',
  'igår',
  'imorgon',
  'tjena',
  'hej',
  'hello',
  'thanks',
  'best',
  'regards',
  'mvh',
  'hi',
  'jag',
  'vi',
  'han',
  'hon',
  'they',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  // Org / product first-tokens — Almi/Tale/Notion/Google etc are orgs that
  // commonly appear as the leading word in a Lu+Lu pair with a sentence-
  // start follower.
  'almi',
  'tale',
  'forge',
  'investerarmöte',
  // Common sentence-start verbs that lead with capitals after period
  'pratade',
  'mötet',
  'mötte',
]);

// 2-word capitalised name regex using Unicode property escapes. Each word:
//   - starts with an uppercase letter (\p{Lu})
//   - followed by ≥2 letters (\p{L} = any letter, includes diacritics like é,
//     ö, å, ñ, etc.)
// Words separated by a single space (NOT newline / tab / multiple spaces) —
// keeps the match within a single line/sentence boundary so titles or
// previous-sentence-end + sentence-start don't accidentally pair up
// (e.g. "Almi Sedan" or "Investerarmöte Henrik" cross-line matches).
// Length is enforced by the {2,} quantifier; the per-word blocklist + the
// ≥3-total length veto at call site filter the rest.
//
// IMPORTANT: with the `u` flag we MUST NOT use \w (which becomes ASCII-only
// under some implementations). All character classes are explicit Unicode.
const NAME_2W_RE = /(\p{Lu}\p{L}{2,}) (\p{Lu}\p{L}{2,})/gu;

// Standard RFC822 From-header pattern: From: "First Last" <addr> | From: First Last <addr>
const FROM_HEADER_RE = /From:\s*"?([^"<\n]+?)"?\s*<([^>\s]+)>/i;

// Sign-offs: English (Best/Thanks/Regards/Cheers) + Swedish (Mvh/Vänligen/Hälsningar)
// followed by name on next line. Uses Unicode-aware classes.
const SIGN_OFF_RE = /(?:Best|Thanks|Regards|Mvh|Vänligen|Hälsningar|Cheers|Tack)[,!.]?\s*\n\s*(\p{Lu}\p{L}+(?:[\- ]\p{Lu}?\p{L}+){1,3})/u;

function isBlocklisted(name: string): boolean {
  const k = name.trim().toLowerCase();
  if (BLOCKLIST.has(k)) return true;
  // Single-word names also blocked (LOW excluded entirely)
  if (!/\s/.test(k)) return true;
  return false;
}

export function extractPersonCandidates(text: string): PersonCandidate[] {
  if (!text || typeof text !== 'string') return [];

  const out = new Map<string, PersonCandidate>();
  const add = (c: PersonCandidate): void => {
    const k = c.name.trim().toLowerCase();
    if (isBlocklisted(c.name)) return;
    const existing = out.get(k);
    // Upgrade: HIGH replaces lower, MEDIUM replaces nothing if HIGH already there.
    if (!existing) {
      out.set(k, c);
      return;
    }
    if (c.confidence === 'high' && existing.confidence !== 'high') {
      out.set(k, c);
    }
  };

  // HIGH: From: header (may appear multiple times in a thread)
  // Use a fresh global RE per call to keep lastIndex isolated.
  const fromGlobal = new RegExp(FROM_HEADER_RE.source, 'gi');
  for (const m of text.matchAll(fromGlobal)) {
    const name = (m[1] ?? '').trim();
    if (!name || !/\s/.test(name)) continue; // require at least 2 tokens
    add({
      name,
      context_snippet: `From: ${m[0]}`.slice(0, 300),
      confidence: 'high',
      source_hint: 'header',
    });
  }

  // HIGH: sign-off (one per text — first match)
  const so = text.match(SIGN_OFF_RE);
  if (so && so[1]) {
    const name = so[1].trim();
    if (/\s/.test(name)) {
      add({
        name,
        context_snippet: so[0].slice(-300),
        confidence: 'high',
        source_hint: 'signature',
      });
    }
  }

  // MEDIUM: capitalised 2-word sequences in body. Use the source RE directly
  // (already global + Unicode); resetting lastIndex via fresh instance keeps
  // state isolated per call.
  const bodyGlobal = new RegExp(NAME_2W_RE.source, 'gu');
  for (const m of text.matchAll(bodyGlobal)) {
    const w1 = m[1] ?? '';
    const w2 = m[2] ?? '';
    if (w1.length < 3 || w2.length < 3) continue;
    // Per-word veto: if EITHER word is in WORD_BLOCKLIST, skip the pair.
    if (
      WORD_BLOCKLIST.has(w1.toLowerCase()) ||
      WORD_BLOCKLIST.has(w2.toLowerCase())
    ) {
      continue;
    }
    const full = `${w1} ${w2}`;
    const idx = m.index ?? 0;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + full.length + 40);
    add({
      name: full,
      context_snippet: text.slice(start, end),
      confidence: 'medium',
      source_hint: 'body',
    });
  }

  return Array.from(out.values());
}
