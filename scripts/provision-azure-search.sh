#!/usr/bin/env bash
# Plan 01-05 — Azure AI Search Basic-tier provisioner.
#
# Purpose: Out-of-band bootstrap of the Azure AI Search service BEFORE
# `cdk deploy KosIntegrations`. The CDK custom-resource Lambda (handler.ts)
# then PUTs the `kos-memory-v1` index with binary quantization at creation
# time (retrofit is not possible — see 01-RESEARCH.md Pattern 5).
#
# Idempotent: re-running against an existing service is a no-op for the
# service-create call, but always refreshes the admin key in Secrets Manager.
#
# Required env:
#   AZURE_SUBSCRIPTION_ID      e.g. 6dd3d2ff-0dd4-4878-b5e2-6bd65893ac74
#   AZURE_SEARCH_SERVICE_NAME  e.g. kos-search-prod (must be globally unique)
# Optional env:
#   AZURE_RESOURCE_GROUP       default: kos-rg
#   AZURE_LOCATION             default: westeurope
#   AWS_REGION                 default: eu-north-1
set -euo pipefail

SUB="${AZURE_SUBSCRIPTION_ID:?set AZURE_SUBSCRIPTION_ID}"
RG="${AZURE_RESOURCE_GROUP:-kos-rg}"
LOCATION="${AZURE_LOCATION:-westeurope}"
SVC="${AZURE_SEARCH_SERVICE_NAME:?set AZURE_SEARCH_SERVICE_NAME e.g. kos-search-prod}"
AWS_RGN="${AWS_REGION:-eu-north-1}"

az account set --subscription "$SUB"

az group create --name "$RG" --location "$LOCATION" >/dev/null

# Check if service exists (idempotent)
EXISTS=$(az search service list --resource-group "$RG" --query "[?name=='$SVC'] | length(@)" -o tsv)
if [ "$EXISTS" = "0" ]; then
  echo "Creating Azure AI Search service $SVC (Basic tier) in $LOCATION..."
  az search service create \
    --name "$SVC" \
    --resource-group "$RG" \
    --location "$LOCATION" \
    --sku basic \
    --replica-count 1 \
    --partition-count 1
else
  echo "[OK] Service $SVC already exists in $RG (skipping create)"
fi

# Fetch admin key + endpoint
ADMIN_KEY=$(az search admin-key show --resource-group "$RG" --service-name "$SVC" --query primaryKey -o tsv)
ENDPOINT="https://$SVC.search.windows.net"

# Seed Secrets Manager (kos/azure-search-admin placeholder was created in Plan 02).
# `put-secret-value` works on both freshly-created (empty) placeholders and
# pre-populated secrets; either way it creates a new version and makes it
# AWSCURRENT.
aws secretsmanager put-secret-value \
  --secret-id kos/azure-search-admin \
  --secret-string "{\"endpoint\":\"$ENDPOINT\",\"adminKey\":\"$ADMIN_KEY\"}" \
  --region "$AWS_RGN" >/dev/null

echo "[OK] Azure AI Search provisioned: $ENDPOINT"
echo "[OK] Secret kos/azure-search-admin updated in $AWS_RGN"
