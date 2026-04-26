/**
 * Phase 8 Plan 08-00 Task 5 — imperative-verb mutation test fixtures.
 *
 * The mutation-proposer (AGT-08) is a 3-stage pipeline:
 *   1. Regex prescreen — bilingual (Swedish + English) imperative verbs
 *   2. Haiku 4.5      — confirms intent (filters regex false-positives)
 *   3. Sonnet 4.6     — resolves the target ref and emits proposed mutation
 *
 * Each fixture row asserts the EXPECTED outcome at each stage so the
 * Plan 08-04 unit tests can verify the correct stage rejects each negative.
 *
 * `regex_should_match` — does the regex prescreen fire?
 * `haiku_is_mutation_expected` — null when regex didn't fire (Haiku not
 *   reached); true/false when Haiku is reached.
 * `sonnet_expected_mutation_type` — null when stage <3 rejects; the expected
 *   mutation_type when Sonnet should resolve.
 */
export interface ImperativeMutationFixture {
  input_text: string;
  lang: 'sv' | 'en' | 'mixed';
  regex_should_match: boolean;
  haiku_is_mutation_expected: boolean | null;
  sonnet_expected_mutation_type:
    | 'cancel_meeting'
    | 'delete_task'
    | 'archive_doc'
    | 'cancel_content_draft'
    | 'cancel_email_draft'
    | 'reschedule_meeting'
    | null;
  notes?: string;
}

export const IMPERATIVE_MUTATION_FIXTURES: ImperativeMutationFixture[] = [
  // Positive — Swedish
  {
    input_text: 'ta bort mötet imorgon kl 11',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_meeting',
    notes: 'The exact 2026-04-23 failure case',
  },
  {
    input_text: 'avboka lunchen med Damien',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_meeting',
  },
  {
    input_text: 'flytta bolagsstämman till onsdag',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'reschedule_meeting',
  },
  {
    input_text: 'arkivera den där AlmI-tasken',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'delete_task',
  },
  {
    input_text: 'stryka draften till Marcus',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_email_draft',
  },

  // Positive — English
  {
    input_text: 'cancel the Damien call',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_meeting',
  },
  {
    input_text: 'delete that content draft for LinkedIn',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_content_draft',
  },
  {
    input_text: 'reschedule the Almi meeting to Thursday',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'reschedule_meeting',
  },
  {
    input_text: 'archive the Tale Forge v2 roadmap',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'archive_doc',
  },
  {
    input_text: 'please cancel tomorrow 11am',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_meeting',
    notes: 'Politeness prefix stripped',
  },

  // Mixed
  {
    input_text: 'ta bort the Damien sync',
    lang: 'mixed',
    regex_should_match: true,
    haiku_is_mutation_expected: true,
    sonnet_expected_mutation_type: 'cancel_meeting',
  },

  // Negative — regex false positives that Haiku catches
  {
    input_text: 'ta bort kaffet från mötet',
    lang: 'sv',
    regex_should_match: true,
    haiku_is_mutation_expected: false,
    sonnet_expected_mutation_type: null,
    notes: 'Regex hits; Haiku filters — coffee is not a KOS record',
  },
  {
    input_text: 'cancel the subscription',
    lang: 'en',
    regex_should_match: true,
    haiku_is_mutation_expected: false,
    sonnet_expected_mutation_type: null,
    notes: 'External service, out of KOS domain',
  },

  // Negative — not imperatives
  {
    input_text: 'jag måste avboka mötet',
    lang: 'sv',
    regex_should_match: false,
    haiku_is_mutation_expected: null,
    sonnet_expected_mutation_type: null,
    notes:
      '1st-person declarative, not imperative — Kevin reports an intent; voice-capture writes the task',
  },
  {
    input_text: 'I canceled the meeting',
    lang: 'en',
    regex_should_match: false,
    haiku_is_mutation_expected: null,
    sonnet_expected_mutation_type: null,
    notes: 'Past tense — Kevin reports a done action',
  },
  {
    input_text: 'should we cancel the Damien call?',
    lang: 'en',
    regex_should_match: false,
    haiku_is_mutation_expected: null,
    sonnet_expected_mutation_type: null,
    notes: 'Question, not imperative',
  },
  {
    input_text: 'mötet kl 11 imorgon',
    lang: 'sv',
    regex_should_match: false,
    haiku_is_mutation_expected: null,
    sonnet_expected_mutation_type: null,
    notes: 'Reminder without verb',
  },
];
