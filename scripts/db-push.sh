#!/usr/bin/env bash
# BLOCKING schema push — applies drizzle/0001_initial.sql + 0002_hnsw_index.sql
# against the deployed KOS RDS and verifies pgvector + 8 tables + HNSW index.
#
# Usage:
#   1. Deploy KosNetwork + KosData with bastion flag (operator, from a machine
#      with AWS credentials for account 239541130189):
#        cd packages/cdk && npx cdk deploy KosNetwork KosData --context bastion=true --require-approval never
#
#   2. Start SSM port-forward (leave running in a separate terminal). Replace
#      <bastion-id> and <rds-endpoint> with values from `aws ec2 describe-instances`
#      and `aws rds describe-db-instances`:
#        aws ssm start-session --target <bastion-id> \
#          --document-name AWS-StartPortForwardingSessionToRemoteHost \
#          --parameters host=<rds-endpoint>,portNumber=5432,localPortNumber=15432 \
#          --region eu-north-1
#
#   3. Run the push (from the repo root):
#        KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push.sh
#
#   4. After push succeeds, redeploy WITHOUT the bastion flag to destroy it:
#        cd packages/cdk && npx cdk deploy KosData --require-approval never
#
# Design notes:
# - We use raw `psql -f` rather than `drizzle-kit migrate` because (a) pgvector
#   extension + HNSW index are raw SQL anyway and (b) the initial bootstrap has
#   no migrations journal on the server side yet. Research line 603 warns
#   against `drizzle-kit push` in steady-state production; for this one-shot
#   bootstrap against an empty DB, applying the hand-authored migrations via
#   psql is the explicit, auditable path.
# - KOS_DB_TUNNEL_PORT=<N> rewrites the host/port to 127.0.0.1:<N> so the SSM
#   port-forward (step 2) transparently becomes the connection target. Without
#   the env var, the script connects to the real RDS endpoint — useful from
#   a Lambda shell or any in-VPC host.
# - Error gates exit non-zero so the BLOCKING verify in PLAN Task 3 fails
#   loudly if any of: extension missing, <8 tables created, or HNSW index
#   absent.

set -euo pipefail

REGION="${AWS_REGION:-eu-north-1}"
echo "=== KOS DB push ==="
echo "Region: $REGION"

# ---------------------------------------------------------------------------
# 1. Resolve RDS credentials from Secrets Manager. CDK's
#    Credentials.fromGeneratedSecret produces a secret whose name starts with
#    the stack name and contains 'RdsInstanceSecret' / 'Credentials'. We try
#    CloudFormation stack-resources first (most precise) then fall back to a
#    list-secrets scan.
# ---------------------------------------------------------------------------
RDS_SECRET_ARN=$(aws cloudformation describe-stack-resources \
  --stack-name KosData --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && contains(LogicalResourceId, 'RdsInstanceSecret')].PhysicalResourceId | [0]" \
  --output text 2>/dev/null || echo "None")

if [ -z "$RDS_SECRET_ARN" ] || [ "$RDS_SECRET_ARN" = "None" ]; then
  RDS_SECRET_ARN=$(aws secretsmanager list-secrets --region "$REGION" \
    --query "SecretList[?starts_with(Name, 'KosData') && contains(Name, 'Credentials')].ARN | [0]" \
    --output text 2>/dev/null || echo "None")
fi

if [ -z "$RDS_SECRET_ARN" ] || [ "$RDS_SECRET_ARN" = "None" ]; then
  echo "Could not resolve RDS credentials secret ARN. Is KosData deployed?"
  exit 1
fi

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$RDS_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)

DB_HOST=$(echo "$SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$SECRET_JSON" | jq -r .port)
DB_USER=$(echo "$SECRET_JSON" | jq -r .username)
DB_PASS=$(echo "$SECRET_JSON" | jq -r .password)
DB_NAME=kos

# Bastion tunnel override: if KOS_DB_TUNNEL_PORT is set, route through
# localhost:<port> (the SSM port-forward destination) while keeping the
# credentials from Secrets Manager.
if [ -n "${KOS_DB_TUNNEL_PORT:-}" ]; then
  echo "Tunnel mode: rewriting host to 127.0.0.1:$KOS_DB_TUNNEL_PORT"
  DB_HOST=127.0.0.1
  DB_PORT="$KOS_DB_TUNNEL_PORT"
fi

export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=require"
echo "Endpoint: $DB_HOST:$DB_PORT"

# ---------------------------------------------------------------------------
# 2. Apply migrations. ON_ERROR_STOP=1 aborts on first failure so a mid-file
#    error doesn't leave a half-created schema.
# ---------------------------------------------------------------------------
cd packages/db
test -f drizzle/0001_initial.sql
test -f drizzle/0002_hnsw_index.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0001_initial.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0002_hnsw_index.sql

# ---------------------------------------------------------------------------
# 3. Verify. Each gate exits non-zero on failure so the outer CI/BLOCKING
#    verify catches all three issues (Pitfall 4, missing tables, missing HNSW).
# ---------------------------------------------------------------------------
EXT_VER=$(psql "$DATABASE_URL" -tA -c "SELECT extversion FROM pg_extension WHERE extname='vector';")
echo "pgvector version: $EXT_VER"
if [ -z "$EXT_VER" ]; then
  echo "FAIL: pgvector extension not installed"
  exit 1
fi

TABLE_COUNT=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('entity_index','project_index','agent_runs','notion_indexer_cursor','mention_events','event_log','telegram_inbox_queue','kevin_context');")
echo "KOS tables present: $TABLE_COUNT / 8"
if [ "$TABLE_COUNT" != "8" ]; then
  echo "FAIL: expected 8 KOS tables, got $TABLE_COUNT"
  exit 1
fi

HNSW=$(psql "$DATABASE_URL" -tA -c "SELECT 1 FROM pg_indexes WHERE indexname='entity_index_embedding_hnsw';")
if [ "$HNSW" != "1" ]; then
  echo "FAIL: HNSW index entity_index_embedding_hnsw missing"
  exit 1
fi

echo "=== DB push complete: pgvector $EXT_VER + 8 tables + HNSW index ==="
