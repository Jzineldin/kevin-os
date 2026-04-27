-- Phase 11 Plan 11-05 — proposal-gated AI outputs.
--
-- Every AI-generated artifact that would land in Kevin's canonical state
-- (morning brief Top 3, transcript action items, enriched entity
-- metadata, draft email classifications) now goes through a proposal
-- row first. Kevin reviews → accept / reject / edit+accept / replace →
-- only THEN does it commit to the real tables.
--
-- This extends the Gate-3 Approve/Edit/Skip pattern from emails to
-- every outgoing agent write. KOS-overview design principle: "Kevin
-- never has to re-explain context, but he stays in control of what
-- actually lands."
--
-- Not a silver bullet — agents whose outputs Kevin explicitly invokes
-- (chat tool mutations, voice capture of his own memo, manual task
-- add via /chat) stay direct-write. Kevin's authoring is already
-- consent; re-asking for Approve would defeat the UX.

BEGIN;

CREATE TABLE IF NOT EXISTS proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL,
  source_agent       text NOT NULL,
  -- Which upstream capture (if any) spawned this proposal. Enables
  -- grouping — a single transcript can spawn 1 entity + 3 action items
  -- + 2 dates, all sharing one capture_id so Kevin can review the
  -- whole thing as a unit.
  capture_id         text,
  kind               text NOT NULL,  -- brief-item | task | entity-link | entity-enrichment | email-classification | action-item | summary
  proposed_payload   jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','replaced','superseded')),
  -- Populated on accept/edit+accept/replace. For simple accept,
  -- resolved_payload = proposed_payload. For edits, contains Kevin's
  -- adjusted version. For replace, contains the alternative Kevin
  -- typed.
  resolved_payload   jsonb,
  user_note          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  -- Optional grouping for same-turn batches (e.g. one brief with 3
  -- Top 3 proposals all grouped under one batch_id so "Accept all"
  -- works cleanly).
  batch_id           uuid
);

CREATE INDEX IF NOT EXISTS idx_proposals_owner_status_created
  ON proposals (owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_owner_kind_status
  ON proposals (owner_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_proposals_batch
  ON proposals (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proposals_capture
  ON proposals (capture_id) WHERE capture_id IS NOT NULL;

COMMENT ON TABLE proposals IS
  'Phase 11 Plan 11-05: AI-generated artifacts held in pending state until Kevin reviews. Extends Gate-3 Approve/Edit/Skip from emails to every agent output. See services/*/persist.ts for dual-write sites.';

-- Grants — dashboard_api reads + mutates, agents insert only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON proposals TO dashboard_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kos_agent_writer') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON proposals TO kos_agent_writer';
  END IF;
END $$;

COMMIT;
