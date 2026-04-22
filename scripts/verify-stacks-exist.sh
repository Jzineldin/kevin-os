#!/usr/bin/env bash
#
# verify-stacks-exist.sh — Gate 1 step 1 helper.
#
# Asserts every Phase 1 CloudFormation stack is in a healthy terminal state.
# The five stacks correspond to Plans 01 (NetworkStack), 02 (DataStack),
# 03 (EventsStack), 04-06 (IntegrationsStack), 07 (SafetyStack).
#
# Exit 0 when all five stacks are CREATE_COMPLETE / UPDATE_COMPLETE /
# UPDATE_ROLLBACK_COMPLETE (rollback-complete is acceptable because CFN leaves
# the resources intact; operator just needs to know a recent deploy had issues).
# Exit 1 if any stack is missing or in a non-terminal/failed state.
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"
MISSING=()
for s in KosNetwork KosData KosEvents KosIntegrations KosSafety; do
  STATUS=$(aws cloudformation describe-stacks \
    --stack-name "$s" \
    --region "$REGION" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "MISSING")
  case "$STATUS" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
      echo "[OK]   $s: $STATUS"
      ;;
    *)
      echo "[FAIL] $s: $STATUS"
      MISSING+=("$s")
      ;;
  esac
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "Missing/unhealthy stacks: ${MISSING[*]}" >&2
  exit 1
fi
echo "[OK] All 5 stacks healthy"
