#!/usr/bin/env bash
# Phase 11 Plan 11-01: verify demo rows have been purged from prod RDS.
#
# Asserts that for owner_id=Kevin:
#   inbox_index    has 0 rows whose title matches the D-03 seed-name set
#   email_drafts   has 0 rows whose subject/draft_subject matches the set
#   agent_dead_letter has 0 rows whose error_message ILIKE-matches the set
#
# Requires (operator-side):
#   - SSM port-forward to RDS already up on localhost:55432, OR a direct
#     PGHOST/PGPORT export pointing at the bastion forwarder.
#   - PGPASSWORD env var (export from kos/db/dashboard_api secret).
#   - psql client on PATH.
#
# Defaults (override via env):
#   PGHOST=localhost PGPORT=55432 PGUSER=dashboard_api PGDATABASE=kos
#
# Exit codes:
#   0 — clean (no demo rows present)
#   1 — pollution detected (one or more demo rows still present)
#   2 — environment / connectivity error (creds missing)

set -euo pipefail

: "${PGPASSWORD:?Need PGPASSWORD env (export from kos/db/dashboard_api secret)}"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-dashboard_api}"
PGDATABASE="${PGDATABASE:-kos}"

# -t = tuples-only, -A = unaligned, returns just the count integer
PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -t -A -v ON_ERROR_STOP=1"

OWNER_ID='7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'

INBOX_COUNT=$($PSQL -c "SELECT COUNT(*) FROM inbox_index WHERE owner_id='$OWNER_ID'::uuid AND title IN ('Damien Carter','Christina Larsson','Jan Eriksson','Lars Svensson','Almi Företagspartner','Re: Partnership proposal','Re: Summer meeting','Possible duplicate: Damien C.','Paused: Maria vs Maria Johansson','Outbehaving angel investor')")
EMAIL_COUNT=$($PSQL -c "SELECT COUNT(*) FROM email_drafts WHERE owner_id='$OWNER_ID'::uuid AND (subject IN ('Re: Partnership proposal','Re: Summer meeting') OR draft_subject IN ('Re: Partnership proposal','Re: Summer meeting'))")
DEAD_COUNT=$($PSQL -c "SELECT COUNT(*) FROM agent_dead_letter WHERE owner_id='$OWNER_ID'::uuid AND error_message ILIKE ANY (ARRAY['%Damien Carter%','%Christina Larsson%','%Jan Eriksson%','%Lars Svensson%','%Almi Företagspartner%','%Outbehaving angel%'])")

echo "inbox_index: $INBOX_COUNT"
echo "email_drafts: $EMAIL_COUNT"
echo "agent_dead_letter: $DEAD_COUNT"

if [ "$INBOX_COUNT" -ne 0 ] || [ "$EMAIL_COUNT" -ne 0 ] || [ "$DEAD_COUNT" -ne 0 ]; then
  echo "FAIL: demo rows still present"
  exit 1
fi

echo "PASS: demo rows absent"
exit 0
