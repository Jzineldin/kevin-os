#!/usr/bin/env bash
# Seeds the four KOS Secrets Manager placeholders after KosData has been
# deployed. CDK creates the secrets (empty shells with RETAIN removal policy);
# this script writes real values interactively.
#
# Usage: bash scripts/seed-secrets.sh
#
# Reads values from the TTY. Typing "PLACEHOLDER" (case-insensitive) or
# leaving the input empty skips that secret — useful for Phase 1 when
# TELEGRAM_BOT_TOKEN / KOS_DASHBOARD_BEARER aren't ready yet.
#
# Values only flow into AWS Secrets Manager; no file artifacts are written.
# Threat T-01-SECRET-01 mitigation.

set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"

echo "=== KOS Secrets Manager seeding ==="
echo "Region: $REGION"
echo "(Enter 'PLACEHOLDER' or empty value to skip a secret.)"
echo ""

SET_COUNT=0
SKIP_COUNT=0

seed_one() {
  local secret_id="$1"
  local label="$2"
  local raw

  # -s suppresses echo so secrets don't end up in terminal scrollback.
  read -r -s -p "$label ($secret_id): " raw
  echo ""

  if [ -z "$raw" ] || [ "${raw,,}" = "placeholder" ]; then
    echo "  [skip] $secret_id"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return 0
  fi

  aws secretsmanager put-secret-value \
    --secret-id "$secret_id" \
    --secret-string "$raw" \
    --region "$REGION" >/dev/null
  echo "  [set]  $secret_id"
  SET_COUNT=$((SET_COUNT + 1))
}

seed_one "kos/notion-token" "NOTION_TOKEN_KOS"
seed_one "kos/azure-search-admin" "AZURE_SEARCH_ADMIN_KEY"
seed_one "kos/telegram-bot-token" "TELEGRAM_BOT_TOKEN"
seed_one "kos/dashboard-bearer" "KOS_DASHBOARD_BEARER"

echo ""
echo "=== Summary ==="
echo "  Set:     $SET_COUNT"
echo "  Skipped: $SKIP_COUNT"
