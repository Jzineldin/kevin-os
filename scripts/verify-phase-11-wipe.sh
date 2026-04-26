#!/usr/bin/env bash
# Phase 11 Plan 11-01: verify demo rows have been purged from prod RDS.
#
# Wave 0 ships the skeleton (exits 0). Wave 1 populates with real psql
# probes (SELECT count FROM inbox_index/email_drafts/agent_dead_letter
# WHERE title/subject/error_message matches D-03 demo-name set). Returns
# non-zero if any demo row is still present.
#
# Wave 1 will require:
#   - SSM port-forward to RDS (operator-driven; see HANDOFF + Plan 11-00)
#   - Read credentials from secretsmanager kos/db/dashboard-reader
#   - psql client on PATH
#
# Usage (Wave 1+):
#   ./scripts/verify-phase-11-wipe.sh
#
# Exit codes:
#   0 — clean (no demo rows present)
#   1 — pollution detected (one or more demo rows still present)
#   2 — environment / connectivity error (bastion unreachable, creds missing)
set -euo pipefail

echo "[verify-phase-11-wipe] STUB — Wave 1 (Plan 11-01) populates real probes"
exit 0
