#!/usr/bin/env bash
# Plan 02-08 — Open-Question-2 resolution runbook.
#
# Lists Bedrock inference profiles in eu-north-1 and prints the Cohere Embed
# Multilingual v3 EU profile ID if one exists, else prints fallback guidance.
#
# Usage:
#   AWS_REGION=eu-north-1 ./scripts/discover-bedrock-embed-profile.sh
#
# Then either:
#   - persist the discovered profile to Secrets Manager:
#       aws secretsmanager put-secret-value \
#         --secret-id kos/cohere-embed-profile-id \
#         --secret-string '<profile-id>'
#   - or set COHERE_EMBED_MODEL_ID env on the notion-indexer Lambda:
#       aws lambda update-function-configuration \
#         --function-name KosIntegrations-NotionIndexer \
#         --environment 'Variables={COHERE_EMBED_MODEL_ID=<profile-id>,...}'
#
# If no EU profile exists, leave both unset — the indexer + bulk import
# default to base `cohere.embed-multilingual-v3` model ID (cross-region to
# us-east-1 for inference; Anthropic-policy "no retention" applies, GDPR-
# acceptable per A1 in 02-RESEARCH.md).
set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"
echo "[i] Listing Bedrock inference profiles in ${REGION}..."
aws bedrock list-inference-profiles --region "$REGION" \
  --query "inferenceProfileSummaries[?contains(inferenceProfileName, 'cohere') || contains(inferenceProfileName, 'embed')].{id:inferenceProfileId,name:inferenceProfileName,models:models[].modelArn}" \
  --output table
echo
echo "[i] If an eu.* profile for cohere.embed-multilingual-v3 exists above, export it via:"
echo "    aws secretsmanager put-secret-value --secret-id kos/cohere-embed-profile-id --secret-string '<profile-id>'"
echo "    OR"
echo "    aws lambda update-function-configuration --function-name KosIntegrations-NotionIndexer --environment 'Variables={COHERE_EMBED_MODEL_ID=<profile-id>,...}'"
echo "[i] Otherwise Plan 02-08/09 Lambdas will fall back to base model ID 'cohere.embed-multilingual-v3'"
echo "    (cross-region to us-east-1; acceptable per A1 + documented in 02-08-SUMMARY.md)."
