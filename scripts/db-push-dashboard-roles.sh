#!/usr/bin/env bash
# Apply migration 0011_dashboard_roles.sql.
#
# Fetches the 3 dashboard role secrets from Secrets Manager (created by
# data-stack.ts) and passes their passwords to psql as `-v` variables so
# CREATE ROLE / ALTER ROLE statements get the matching passwords that
# RDS Proxy will use for AS-authentication.
#
# Usage (same tunnel pattern as scripts/db-push.sh):
#   1. Deploy data-stack with bastion (if not already up):
#        cd packages/cdk && npx cdk deploy KosNetwork KosData --context bastion=true --require-approval never
#   2. SSM port-forward (separate terminal):
#        aws ssm start-session --target <bastion-id> \
#          --document-name AWS-StartPortForwardingSessionToRemoteHost \
#          --parameters host=<rds-endpoint>,portNumber=5432,localPortNumber=15432 \
#          --region eu-north-1
#   3. KOS_DB_TUNNEL_PORT=15432 bash scripts/db-push-dashboard-roles.sh

set -euo pipefail
REGION="${AWS_REGION:-eu-north-1}"

echo "=== KOS DB push: dashboard roles (migration 0011) ==="

# --- Master credentials (for opening the psql session as kos_admin) ---------
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
  echo "Could not resolve RDS master credentials secret. Is KosData deployed?"
  exit 1
fi
SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$RDS_SECRET_ARN" \
  --region "$REGION" --query SecretString --output text)
DB_HOST=$(echo "$SECRET_JSON" | jq -r .host)
DB_PORT=$(echo "$SECRET_JSON" | jq -r .port)
DB_USER=$(echo "$SECRET_JSON" | jq -r .username)
DB_PASS=$(echo "$SECRET_JSON" | jq -r .password)
DB_NAME=kos
if [ -n "${KOS_DB_TUNNEL_PORT:-}" ]; then
  echo "Tunnel mode: rewriting host to 127.0.0.1:$KOS_DB_TUNNEL_PORT"
  DB_HOST=127.0.0.1
  DB_PORT="$KOS_DB_TUNNEL_PORT"
fi
export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=require"

# --- Fetch dashboard role passwords -----------------------------------------
fetch_pwd() {
  local name="$1"
  aws secretsmanager get-secret-value --secret-id "kos/db/$name" --region "$REGION" \
    --query SecretString --output text | jq -r .password
}
echo "Fetching role passwords from Secrets Manager..."
RELAY_PWD=$(fetch_pwd dashboard_relay)
API_PWD=$(fetch_pwd dashboard_api)
NOTIFY_PWD=$(fetch_pwd dashboard_notify)
if [ -z "$RELAY_PWD" ] || [ -z "$API_PWD" ] || [ -z "$NOTIFY_PWD" ]; then
  echo "FAIL: one or more kos/db/* secrets missing or empty. Did data-stack deploy?"
  exit 1
fi

# --- Apply migration --------------------------------------------------------
cd packages/db
test -f drizzle/0011_dashboard_roles.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v dashboard_relay_password="$RELAY_PWD" \
  -v dashboard_api_password="$API_PWD" \
  -v dashboard_notify_password="$NOTIFY_PWD" \
  -f drizzle/0011_dashboard_roles.sql

# --- Verify -----------------------------------------------------------------
ROLE_COUNT=$(psql "$DATABASE_URL" -tA -c \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('dashboard_relay','dashboard_api','dashboard_notify');")
echo "Dashboard roles present: $ROLE_COUNT / 3"
if [ "$ROLE_COUNT" != "3" ]; then
  echo "FAIL: expected 3 dashboard roles after migration, got $ROLE_COUNT"
  exit 1
fi

echo "=== Migration 0011 complete: 3 roles created/updated, IAM grants in place ==="
