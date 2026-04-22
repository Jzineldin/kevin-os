#!/usr/bin/env bash
#
# backfill-notion.sh — invoke the notion-indexer-backfill Lambda twice per
# watched DB (D-11: 4 DBs), 60 s apart. Asserts rows_inserted=0 on the second
# invocation per DB (D-10 idempotency contract).
#
# Deferred to operator — requires real AWS creds + deployed KosIntegrations.
#
# Usage:
#   AWS_REGION=eu-north-1 bash scripts/backfill-notion.sh
#
set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"
FUNCTION_NAME="${BACKFILL_FUNCTION_NAME:-}"

if [ -z "$FUNCTION_NAME" ]; then
  # Discover by tag/prefix — IntegrationsStack names this logical id NotionIndexerBackfill.
  FUNCTION_NAME=$(aws lambda list-functions --region "$REGION" \
    --query "Functions[?contains(FunctionName, 'NotionIndexerBackfill')].FunctionName | [0]" \
    --output text)
fi

if [ -z "$FUNCTION_NAME" ] || [ "$FUNCTION_NAME" = "None" ]; then
  echo "FATAL: NotionIndexerBackfill Lambda not found. Set BACKFILL_FUNCTION_NAME." >&2
  exit 2
fi

IDS_FILE="$(dirname "$0")/.notion-db-ids.json"
if [ ! -f "$IDS_FILE" ]; then
  echo "FATAL: $IDS_FILE not found. Run bootstrap-notion-dbs.mjs first." >&2
  exit 2
fi

ENTITIES_ID=$(jq -r .entities "$IDS_FILE")
PROJECTS_ID=$(jq -r .projects "$IDS_FILE")
KEVIN_CONTEXT_ID=$(jq -r .kevinContext "$IDS_FILE")
COMMAND_CENTER_ID=$(jq -r .commandCenter "$IDS_FILE")

if [ "$ENTITIES_ID" = "pending-bootstrap" ]; then
  echo "FATAL: .notion-db-ids.json holds placeholder IDs. Run bootstrap first." >&2
  exit 2
fi

declare -A DBS=(
  [entities]="$ENTITIES_ID"
  [projects]="$PROJECTS_ID"
  [kevin_context]="$KEVIN_CONTEXT_ID"
  [command_center]="$COMMAND_CENTER_ID"
)

EXIT_CODE=0
for KIND in entities projects kevin_context command_center; do
  ID="${DBS[$KIND]}"
  PAYLOAD=$(jq -nc --arg dbId "$ID" --arg dbKind "$KIND" '{dbId: $dbId, dbKind: $dbKind}')
  OUT1="/tmp/backfill-${KIND}-1.json"
  OUT2="/tmp/backfill-${KIND}-2.json"

  echo "[backfill] $KIND invocation 1/2"
  aws lambda invoke --region "$REGION" --function-name "$FUNCTION_NAME" \
    --payload "$PAYLOAD" --cli-binary-format raw-in-base64-out "$OUT1" >/dev/null
  cat "$OUT1"
  echo

  sleep 60

  echo "[backfill] $KIND invocation 2/2"
  aws lambda invoke --region "$REGION" --function-name "$FUNCTION_NAME" \
    --payload "$PAYLOAD" --cli-binary-format raw-in-base64-out "$OUT2" >/dev/null
  cat "$OUT2"
  echo

  INSERTED=$(jq -r '.rows_inserted // 0' "$OUT2")
  if [ "$INSERTED" != "0" ]; then
    echo "FAIL: $KIND second run reported rows_inserted=$INSERTED (expected 0)" >&2
    EXIT_CODE=1
  else
    echo "PASS: $KIND second run is idempotent (rows_inserted=0)"
  fi
done

exit $EXIT_CODE
