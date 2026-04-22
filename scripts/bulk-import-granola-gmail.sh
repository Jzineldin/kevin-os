#!/usr/bin/env bash
# Plan 02-09 — kick off bulk-import-granola-gmail Lambda. Supports --dry-run.
#
# Usage:
#   ./scripts/bulk-import-granola-gmail.sh             # real run, creates rows
#   ./scripts/bulk-import-granola-gmail.sh --dry-run   # counts only, 0 creates
#   ./scripts/bulk-import-granola-gmail.sh --gmail     # only Gmail leg
#   ./scripts/bulk-import-granola-gmail.sh --granola   # only Granola leg
#
# Pre-reqs:
#   - AWS CLI configured
#   - KosAgents stack deployed (BulkImportGranolaGmail Lambda exists)
#   - For Gmail leg: kos/gmail-oauth-tokens secret populated via
#     scripts/gmail-oauth-init.ts (one-time per Kevin Gmail account)
#   - Transkripten Notion DB exists (Granola sync running) OR
#     TRANSKRIPTEN_DB_ID env set on the Lambda config
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"

FN_NAME=$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName, 'KosAgents-BulkImportGranolaGmail')].FunctionName | [0]" \
  --output text)
if [ -z "$FN_NAME" ] || [ "$FN_NAME" = "None" ]; then
  echo "[ERR] BulkImportGranolaGmail Lambda not found; deploy KosAgents first" >&2
  exit 1
fi

PAYLOAD='{}'
case "${1:-}" in
  --dry-run)  PAYLOAD='{"dryRun":true}'; echo "[i] dry-run mode — no Inbox rows will be created" ;;
  --gmail)    PAYLOAD='{"sources":"gmail"}'; echo "[i] Gmail-only mode" ;;
  --granola)  PAYLOAD='{"sources":"granola"}'; echo "[i] Granola-only mode" ;;
  '') ;;
  *) echo "[ERR] unknown arg: ${1}" >&2; exit 2 ;;
esac

echo "[i] Invoking $FN_NAME in $REGION..."
aws lambda invoke \
  --function-name "$FN_NAME" \
  --payload "$PAYLOAD" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  /tmp/ent06-result.json
echo "[*] result:"
cat /tmp/ent06-result.json
echo
