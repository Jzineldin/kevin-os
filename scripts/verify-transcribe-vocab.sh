#!/usr/bin/env bash
# verify-transcribe-vocab.sh — Gate verification for Plan 01-06.
#
# Asserts that the Transcribe custom vocabulary `kos-sv-se-v1` exists in the
# region resolved by the Wave 0 preflight (scripts/.transcribe-region), has
# state READY, and is LanguageCode sv-SE.
#
# Exit codes:
#   0 — READY + sv-SE
#   1 — state is not READY
#   2 — LanguageCode is not sv-SE
#   3 — region file missing / empty
#
# Usage: bash scripts/verify-transcribe-vocab.sh
set -euo pipefail

REGION_FILE="scripts/.transcribe-region"
if [ ! -s "$REGION_FILE" ]; then
  echo "verify-transcribe-vocab: $REGION_FILE missing or empty — run Wave 0 preflight" >&2
  exit 3
fi
REGION=$(cat "$REGION_FILE" | tr -d '[:space:]')

STATE=$(aws transcribe get-vocabulary \
  --vocabulary-name kos-sv-se-v1 \
  --region "$REGION" \
  --query VocabularyState \
  --output text)
if [ "$STATE" != "READY" ]; then
  echo "vocabulary state is $STATE (expected READY)" >&2
  exit 1
fi

LANG=$(aws transcribe get-vocabulary \
  --vocabulary-name kos-sv-se-v1 \
  --region "$REGION" \
  --query LanguageCode \
  --output text)
if [ "$LANG" != "sv-SE" ]; then
  echo "vocabulary LanguageCode is $LANG (expected sv-SE)" >&2
  exit 2
fi

echo "[OK] kos-sv-se-v1 READY (sv-SE) in $REGION"
