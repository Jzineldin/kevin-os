#!/usr/bin/env bash
# Plan 02-08 — kick off bulk-import-kontakter Lambda. Supports --dry-run.
#
# Usage:
#   ./scripts/bulk-import-kontakter.sh             # real run, creates rows
#   ./scripts/bulk-import-kontakter.sh --dry-run   # counts only, 0 creates
#
# Requires: AWS CLI configured, KosAgents stack deployed.
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"
FN_NAME=$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName, 'KosAgents-BulkImportKontakter')].FunctionName | [0]" \
  --output text)
if [ -z "$FN_NAME" ] || [ "$FN_NAME" = "None" ]; then
  echo "[ERR] BulkImportKontakter Lambda not found; deploy KosAgents first" >&2
  exit 1
fi
echo "[i] Invoking $FN_NAME in $REGION..."
PAYLOAD='{}'
if [[ "${1:-}" == "--dry-run" ]]; then
  PAYLOAD='{"dryRun":true}'
  echo "[i] dry-run mode — no Inbox rows will be created"
fi
aws lambda invoke \
  --function-name "$FN_NAME" \
  --payload "$PAYLOAD" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  /tmp/kontakter-result.json
echo "[*] result:"
cat /tmp/kontakter-result.json
echo
