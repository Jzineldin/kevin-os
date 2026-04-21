#!/usr/bin/env bash
# KOS Phase 1 preflight — verifies the local environment is ready for Wave 0+.
# Resolves Research Assumption A9 (Transcribe sv-SE region) and ensures CDK is
# bootstrapped for the target AWS account in eu-north-1.

set -euo pipefail

echo "=== KOS Phase 1 Preflight ==="

# 1. Node version. Baseline is 22.12.0 (pinned in .nvmrc). Accept any Node >=22
#    because current dev machines may run 24.x — stack still works.
NODE_VERSION="$(node --version || true)"
if [[ ! "${NODE_VERSION}" =~ ^v(22|23|24|25)\. ]]; then
  echo "[FAIL] Node 22.x or newer required (found: ${NODE_VERSION})"
  exit 1
fi
echo "[OK] Node ${NODE_VERSION}"

# 2. pnpm.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[FAIL] pnpm required"
  exit 1
fi
echo "[OK] pnpm $(pnpm --version)"

# 3. AWS CLI.
if ! command -v aws >/dev/null 2>&1; then
  echo "[FAIL] AWS CLI v2 required"
  exit 1
fi
echo "[OK] aws $(aws --version 2>&1 | head -1)"

# 4. Azure CLI — warn only. Azure bootstrap lives in Plan 05.
if ! command -v az >/dev/null 2>&1; then
  echo "[WARN] Azure CLI not found — install before Plan 05 (Azure AI Search bootstrap)"
else
  echo "[OK] az CLI present"
fi

# 5. AWS credentials.
AWS_ACCOUNT="$(aws sts get-caller-identity --output text --query Account 2>/dev/null || true)"
if [[ -z "${AWS_ACCOUNT}" ]] || ! [[ "${AWS_ACCOUNT}" =~ ^[0-9]{12}$ ]]; then
  echo "[FAIL] AWS credentials not configured (aws sts get-caller-identity returned empty)"
  exit 1
fi
echo "[OK] AWS account ${AWS_ACCOUNT}"

# 6. A9 — Transcribe sv-SE region probe (eu-north-1 → eu-west-1 fallback).
REGION_FILE="scripts/.transcribe-region"
if aws transcribe list-vocabularies --region eu-north-1 --max-results 1 >/dev/null 2>&1; then
  echo "eu-north-1" > "${REGION_FILE}"
  echo "[OK] AWS Transcribe sv-SE reachable in eu-north-1"
elif aws transcribe list-vocabularies --region eu-west-1 --max-results 1 >/dev/null 2>&1; then
  echo "eu-west-1" > "${REGION_FILE}"
  echo "[FALLBACK] Using eu-west-1 for Transcribe"
else
  echo "[FAIL] AWS Transcribe unreachable in both eu-north-1 and eu-west-1"
  exit 1
fi

# 6b. Operator handoff note for Plan 04 — Command Center DB already exists in
#     Kevin's Notion workspace. Plan 04 bootstrap script expects
#     EXISTING_COMMAND_CENTER_DB_ID to be exported before `node
#     scripts/bootstrap-notion-dbs.mjs` runs so the ID can be persisted to
#     scripts/.notion-db-ids.json under `commandCenter`. Wave 0 cannot set this
#     automatically (secret lives with Kevin); this echo flags the handoff.
echo "[NOTE] Plan 04 requires EXISTING_COMMAND_CENTER_DB_ID env var in the shell before bootstrap"

# 7. CDK bootstrap in eu-north-1.
CDK_STATUS="$(aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --region eu-north-1 \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo 'NOT_FOUND')"

case "${CDK_STATUS}" in
  CREATE_COMPLETE|UPDATE_COMPLETE)
    echo "[OK] CDK already bootstrapped in eu-north-1 (${CDK_STATUS})"
    ;;
  *)
    echo "Bootstrapping CDK in aws://${AWS_ACCOUNT}/eu-north-1 ..."
    # NOTE: aws-cdk CLI 2.1118.4 short-circuits `cdk bootstrap` when run from a
    # directory whose cdk.json app has zero stacks (empty Phase 1 app). Run
    # bootstrap from a neutral temp dir where no cdk.json is resolved.
    BOOTSTRAP_TMP="$(mktemp -d)"
    (cd "${BOOTSTRAP_TMP}" && npx --yes aws-cdk@2.1118.4 bootstrap "aws://${AWS_ACCOUNT}/eu-north-1")
    rm -rf "${BOOTSTRAP_TMP}"
    echo "[OK] CDK bootstrap complete"
    ;;
esac

# 8. VPS SSH reachability — warn only. Phase 7 freeze task re-verifies.
if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    kevin@98.91.6.66 'echo ok' >/dev/null 2>&1; then
  echo "[OK] VPS SSH reachable (98.91.6.66)"
else
  echo "[WARN] VPS SSH not reachable — Phase 7 freeze task will re-verify"
fi

echo "=== Preflight passed ==="
