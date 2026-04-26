-- Phase 11 D-03 demo-row wipe.
--
-- Removes the 10 enumerated seed names from prod RDS for owner_id=Kevin.
-- Targets three tables: inbox_index (titles), email_drafts (subject /
-- draft_subject), agent_dead_letter (error_message ILIKE).
--
-- Pre-wipe inventory captured by Wave 0 in:
--   .planning/phases/11-frontend-rebuild-real-data-wiring-button-audit-mission-contr/demo-rows-pre-wipe.csv
-- (7 rows in inbox_index; 0 in email_drafts; 0 in agent_dead_letter.)
--
-- Reversibility: re-INSERT from the pre-wipe CSV if Kevin disagrees with
-- what was deleted. The transaction wraps every probe + DELETE in a
-- single envelope — the operator can ROLLBACK if PRE counts diverge from
-- the CSV.
--
-- Owner UUID literal: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c' — sourced
-- from packages/db/src/owner.ts and migration 0008. Verified pre-wipe
-- in the Wave 0 schema dump (11-WAVE-0-SCHEMA-VERIFICATION.md §o-p).

BEGIN;

-- =====================================================================
-- PRE-FLIGHT — operator visually confirms these counts match the
-- pre-wipe CSV row counts per table BEFORE proceeding.
-- =====================================================================

SELECT 'inbox_index PRE' AS marker, COUNT(*) AS n FROM inbox_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND title IN (
      'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
      'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
      'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor'
    );

SELECT 'email_drafts PRE' AS marker, COUNT(*) AS n FROM email_drafts
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND (
      subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
      OR draft_subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
    );

SELECT 'agent_dead_letter PRE' AS marker, COUNT(*) AS n FROM agent_dead_letter
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND error_message ILIKE ANY (ARRAY[
      '%Damien Carter%', '%Christina Larsson%', '%Jan Eriksson%',
      '%Lars Svensson%', '%Almi Företagspartner%', '%Outbehaving angel%'
    ]);

-- =====================================================================
-- DELETE PHASE — operator pauses here, compares the 3 PRE counts above
-- to the pre-wipe CSV (expected: 7 / 0 / 0). If matched, runs the rest
-- of this file. If not, types ROLLBACK; instead of COMMIT; below.
-- =====================================================================

DELETE FROM inbox_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND title IN (
      'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
      'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
      'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor'
    );

DELETE FROM email_drafts
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND (
      subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
      OR draft_subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
    );

DELETE FROM agent_dead_letter
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND error_message ILIKE ANY (ARRAY[
      '%Damien Carter%', '%Christina Larsson%', '%Jan Eriksson%',
      '%Lars Svensson%', '%Almi Företagspartner%', '%Outbehaving angel%'
    ]);

-- =====================================================================
-- POST-FLIGHT — all three MUST return 0. Otherwise ROLLBACK.
-- =====================================================================

SELECT 'inbox_index POST' AS marker, COUNT(*) AS n FROM inbox_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND title IN (
      'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
      'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
      'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor'
    );

SELECT 'email_drafts POST' AS marker, COUNT(*) AS n FROM email_drafts
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND (
      subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
      OR draft_subject IN ('Re: Partnership proposal', 'Re: Summer meeting')
    );

SELECT 'agent_dead_letter POST' AS marker, COUNT(*) AS n FROM agent_dead_letter
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND error_message ILIKE ANY (ARRAY[
      '%Damien Carter%', '%Christina Larsson%', '%Jan Eriksson%',
      '%Lars Svensson%', '%Almi Företagspartner%', '%Outbehaving angel%'
    ]);

-- COMMIT only if all 3 POST counts are 0. Otherwise type ROLLBACK; instead.
COMMIT;
