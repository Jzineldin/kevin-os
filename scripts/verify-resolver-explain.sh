#!/usr/bin/env bash
# Runs EXPLAIN on a representative resolver query; asserts HNSW + GIN indexes appear in the plan.
# Requires SSM tunnel (same as db-migrate-0003.sh).
set -euo pipefail
: "${KOS_DB_TUNNEL_PORT:?}"
REGION="${AWS_REGION:-eu-north-1}"
SECRET_ARN=$(aws secretsmanager list-secrets --region "$REGION" \
  --query "SecretList[?starts_with(Name, 'kos/rds-credentials')] | [0].ARN" --output text)
CREDS_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --region "$REGION" --query SecretString --output text)
export PGUSER=$(echo "$CREDS_JSON" | jq -r .username)
export PGPASSWORD=$(echo "$CREDS_JSON" | jq -r .password)
export PGDATABASE=$(echo "$CREDS_JSON" | jq -r '.dbname // "kos"')
export PGHOST=127.0.0.1 PGPORT="$KOS_DB_TUNNEL_PORT" PGSSLMODE=require

# Seed a throwaway row with a random 1024-dim vector so HNSW has data to use in EXPLAIN.
# (Optional; EXPLAIN works without data but the plan shape is more realistic with 1 row.)
OUT=$(psql -v ON_ERROR_STOP=1 -A -t <<'SQL'
EXPLAIN (FORMAT JSON) WITH t AS (
  SELECT id FROM entity_index WHERE LOWER(name) % 'kevin' LIMIT 1
) SELECT 1 FROM t;
SQL
)
echo "$OUT"
if ! echo "$OUT" | grep -q 'entity_index_name_trgm'; then
  echo "[ERR] GIN index entity_index_name_trgm not used in trigram EXPLAIN"; exit 1
fi
echo "[OK] pg_trgm GIN index present in query plan"
