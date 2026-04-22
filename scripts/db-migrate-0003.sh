#!/usr/bin/env bash
# BLOCKING — run 0003 + 0004 migrations against live RDS via SSM bastion tunnel.
# Pattern: identical to Phase 1 scripts/db-push.sh (KOS_DB_TUNNEL_PORT=15432).
#
# Prerequisites:
#   1. DataStack + IntegrationsStack deployed
#   2. bastion re-raised temporarily: `cd packages/cdk && npx cdk deploy KosData --context bastion=true --require-approval never`
#   3. SSM port-forward running in another terminal:
#        aws ssm start-session --target <bastion-id> \
#          --document-name AWS-StartPortForwardingSessionToRemoteHost \
#          --parameters "host=<rds-endpoint>,portNumber=5432,localPortNumber=15432" \
#          --region eu-north-1
#
# Usage:
#   KOS_DB_TUNNEL_PORT=15432 bash scripts/db-migrate-0003.sh
#
# Post-migration: `cd packages/cdk && npx cdk deploy KosData --require-approval never` to tear down bastion (T-01-BASTION-01).
set -euo pipefail

: "${KOS_DB_TUNNEL_PORT:?Set KOS_DB_TUNNEL_PORT=15432 after starting SSM port-forward}"
REGION="${AWS_REGION:-eu-north-1}"

# Pull RDS admin creds from Secrets Manager
SECRET_ARN=$(aws secretsmanager list-secrets --region "$REGION" \
  --query "SecretList[?starts_with(Name, 'kos/rds-credentials')] | [0].ARN" --output text)
if [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = "None" ]; then
  echo "[ERR] could not locate kos/rds-credentials secret in $REGION"; exit 1
fi
CREDS_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region "$REGION" --query SecretString --output text)
PGUSER=$(echo "$CREDS_JSON" | jq -r .username)
PGPASSWORD=$(echo "$CREDS_JSON" | jq -r .password)
PGDATABASE=$(echo "$CREDS_JSON" | jq -r '.dbname // "kos"')
export PGHOST=127.0.0.1 PGPORT="$KOS_DB_TUNNEL_PORT" PGUSER PGPASSWORD PGDATABASE
export PGSSLMODE=require

echo "[*] Running migration 0003 (vector 1536 → 1024 + embedding_model)"
psql -v ON_ERROR_STOP=1 -f packages/db/drizzle/0003_cohere_embedding_dim.sql

echo "[*] Running migration 0004 (pg_trgm + GIN + HNSW recreate)"
psql -v ON_ERROR_STOP=1 -f packages/db/drizzle/0004_pg_trgm_indexes.sql

echo "[*] Verifying post-state"
psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  (SELECT format_type(a.atttypid, a.atttypmod)
     FROM pg_attribute a JOIN pg_class c ON a.attrelid=c.oid
     WHERE c.relname='entity_index' AND a.attname='embedding') AS embedding_type,
  (SELECT COUNT(*) FROM pg_extension WHERE extname='pg_trgm') AS has_pg_trgm,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname='entity_index_name_trgm') AS has_trgm_idx,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname='entity_index_embedding_hnsw') AS has_hnsw,
  (SELECT a.attname FROM pg_attribute a JOIN pg_class c ON a.attrelid=c.oid
     WHERE c.relname='entity_index' AND a.attname='embedding_model') AS has_embedding_model;
SQL

echo "[OK] migrations 0003+0004 applied"
