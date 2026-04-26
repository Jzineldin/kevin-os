# One-shot admin DB access via in-VPC Lambda

**When to use:** you need to run a SQL script against prod RDS with admin privileges (DELETE, DDL, role changes, migrations that need `kos_admin`). The bastion is terminated or too slow to spin up.

**Why this exists:** this EC2 (and most dev boxes) live in a different VPC than RDS. Direct TCP to the RDS host fails. The service Lambdas (notion-indexer, triage, etc.) already have the VPC+SG+subnet config that can reach RDS. We piggy-back on that pattern for a one-shot admin Lambda.

## The canonical wipe was run

Demo-row wipe ran successfully 2026-04-26 23:02 UTC. Result: `inbox_index PRE=7 POST=0`. `email_drafts` and `agent_dead_letter` had nothing to delete.

## Reusable pattern (next time you need it)

### 1. Build the Lambda bundle

```bash
mkdir -p /tmp/admin-xxx && cd /tmp/admin-xxx
# Copy handler.mjs, package.json, and your SQL file from this directory
cp /home/ubuntu/projects/kevin-os/scripts/admin-wipe-lambda/handler.mjs .
cp /home/ubuntu/projects/kevin-os/scripts/admin-wipe-lambda/package.json .
cp /home/ubuntu/projects/kevin-os/scripts/<your>.sql wipe.sql
npm install --omit=dev --no-audit --no-fund --silent
zip -rq bundle.zip handler.mjs package.json wipe.sql node_modules
```

### 2. Create IAM role (one-time per run — delete after)

```bash
ROLE=kos-admin-oneshot-$(date +%s)
aws iam create-role --role-name $ROLE --assume-role-policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
}'
aws iam attach-role-policy --role-name $ROLE \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
aws iam put-role-policy --role-name $ROLE --policy-name secrets-read --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue",
    "Resource":"arn:aws:secretsmanager:eu-north-1:239541130189:secret:KosDataRdsInstanceSecret430-*"}]
}'
sleep 12  # role propagation
```

### 3. Create + invoke Lambda (must be in kos VPC)

```bash
FN=kos-admin-oneshot-$(date +%s)
aws lambda create-function --region eu-north-1 \
  --function-name $FN \
  --runtime nodejs22.x \
  --role arn:aws:iam::239541130189:role/$ROLE \
  --handler handler.handler \
  --timeout 60 --memory-size 512 \
  --zip-file fileb://bundle.zip \
  --vpc-config SubnetIds=subnet-0d56ba47ff97d6892,subnet-00a8907e65b2c7873,SecurityGroupIds=sg-0aaf935eabd3ee0d7 \
  --environment 'Variables={MASTER_SECRET_ID=KosDataRdsInstanceSecret430-WhjHZXmxHINa}'

aws lambda wait function-updated --region eu-north-1 --function-name $FN
aws lambda invoke --region eu-north-1 --function-name $FN \
  --cli-binary-format raw-in-base64-out --payload '{}' /tmp/out.json
cat /tmp/out.json | jq
```

### 4. Tear down immediately after

```bash
aws lambda delete-function --region eu-north-1 --function-name $FN
aws iam delete-role-policy --role-name $ROLE --policy-name secrets-read
aws iam detach-role-policy --role-name $ROLE \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
aws iam delete-role --role-name $ROLE
```

## Canonical values (do not guess)

| Thing | Value |
|---|---|
| AWS account | `239541130189` |
| Region | `eu-north-1` |
| RDS VPC | `vpc-02675f6ccc181f6b3` |
| RDS subnets (private) | `subnet-0d56ba47ff97d6892`, `subnet-00a8907e65b2c7873` |
| RDS SG | `sg-0aaf935eabd3ee0d7` |
| RDS host | `kosdata-rdsinstance5075e838-9prpmgxajujc.cts46s6u6r3l.eu-north-1.rds.amazonaws.com` |
| RDS Proxy | `kosdatardsproxy4518f30a.proxy-cts46s6u6r3l.eu-north-1.rds.amazonaws.com` |
| Master secret | `KosDataRdsInstanceSecret430-WhjHZXmxHINa` (role: `kos_admin`) |
| DB name | `kos` |
| Kevin owner_id | `7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c` |

## Safety rules

- **Always wrap DESTRUCTIVE SQL in `BEGIN; ... COMMIT;`** — the `pg` driver executes the whole file as a single multi-statement query; a SQL-level error aborts before COMMIT.
- **Always include PRE + POST count probes** — makes a bad wipe discoverable in the response.
- **Never leave the Lambda or role around after use.** The role carries `secretsmanager:GetSecretValue` on the master secret. Tear it down.
- **Use `ssl: { rejectUnauthorized: false }`** — RDS certs aren't in the Lambda trust store. This is fine inside the VPC; the connection is still encrypted.
- **Connect to the RDS instance directly, NOT the RDS Proxy,** when using the master-secret password. The proxy is configured for IAM auth (`kos_agent_writer`, etc.), not master password.
