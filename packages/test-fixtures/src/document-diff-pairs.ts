/**
 * Phase 8 Plan 08-00 Task 5 — document version diff pairs.
 *
 * document-diff Lambda (Plan 08-05) extracts text from PDFs (pdf-parse) /
 * docx (mammoth), computes sha256, looks up prior versions, then runs
 * Haiku 4.5 to produce a one-paragraph diff summary. These fixtures
 * exercise three classes of change:
 *   1. Substantive content addition (new clause)
 *   2. Trivial reformat (whitespace/punctuation only — Haiku must say so)
 *   3. Numeric value change (Haiku must call out both old + new)
 *
 * `expected_summary_contains` is a soft assertion: Plan 08-05 tests check
 * the Haiku output mentions at least one token from the array.
 */
export const DOCUMENT_DIFF_PAIRS = [
  {
    name: 'avtal_v3_to_v4_esop_clause_added',
    prior_text: 'Kapitel 4: Vesting\n4.1 Grundvesting är 4 år.',
    current_text:
      'Kapitel 4: Vesting\n4.1 Grundvesting är 4 år.\n4.2 ESOP allokering: 10% av totala aktier reserverat.',
    expected_summary_contains: ['4.2', 'ESOP'],
  },
  {
    name: 'avtal_v4_to_v5_formatting_only',
    prior_text: 'Kapitel 4: Vesting\n4.1 Grundvesting är 4 år.',
    current_text: 'Kapitel 4: Vesting.\n4.1 Grundvesting är 4 år.',
    expected_summary_contains: ['trivial'],
  },
  {
    name: 'english_number_change',
    prior_text: 'Investment amount: 1,000,000 SEK.',
    current_text: 'Investment amount: 1,500,000 SEK.',
    expected_summary_contains: ['1,500,000', '1,000,000'],
  },
];
