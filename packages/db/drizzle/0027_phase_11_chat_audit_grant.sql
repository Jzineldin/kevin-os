-- Phase 11 Plan 11-04: dashboard_api needs INSERT on event_log so the
-- /chat tool-use path can log mutations ('kos-chat:priority-updated',
-- 'kos-chat:status-updated', 'kos-chat:task-created'). Applied live
-- 2026-04-27 and codified here so a rebuilt environment gets it.
--
-- Idempotent: GRANT is a no-op if the privilege is already held.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    EXECUTE 'GRANT INSERT ON event_log TO dashboard_api';
  END IF;
END $$;

-- Phase 11 Plan 11-04 C: dashboard_api writes the Sonnet-synthesised
-- "What you need to know" block into entity_dossiers_cached on demand
-- via POST /entities/:id/synthesize. Applied live 2026-04-27.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    EXECUTE 'GRANT INSERT, UPDATE ON entity_dossiers_cached TO dashboard_api';
  END IF;
END $$;
