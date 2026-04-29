# Phase B Bootstrap Scripts

One-time setup scripts used 2026-04-29 to bootstrap the openclaw-bridge
Lambda + RDS user + Secrets Manager entries. Kept in-tree for auditability
and disaster recovery.

## Order of operations

### 1. Create DB user + grants
Run the `kos-bridge-bootstrap` Lambda (see `bootstrap-rds-user.mjs`). This
Lambda lives in the VPC and uses the master RDS secret to:
- Create role `kos_openclaw_bridge` with login password
- GRANT CONNECT ON DATABASE kos
- GRANT USAGE ON SCHEMA public
- GRANT SELECT on: entity_index, mention_events, project_index, inbox_index, top3_membership

Idempotent — safe to re-run for password rotation.

### 2. Register user with RDS Proxy
Add the new secret ARN to the proxy's Auth list via `aws rds modify-db-proxy`.
Wait ~60s for proxy to re-poll secrets.

### 3. Deploy the bridge Lambda
Either:
- `pnpm -F @kos/cdk synth OpenclawBridgeStack && pnpm -F @kos/cdk deploy OpenclawBridgeStack` (full CDK)
- Or esbuild + `aws lambda create-function` (shortcut used on 2026-04-29 due to CDK OOM on t3.medium)

### 4. Grant RDS Proxy role access to new secret
Proxy needs `secretsmanager:GetSecretValue` on the new kos_openclaw_bridge secret.

### 5. Store bearer token + bridge URL in OpenClaw
`~/.openclaw/secrets/bridge.env`:
```
export KOS_BRIDGE_URL=https://<fn-url-id>.lambda-url.eu-north-1.on.aws
export KOS_BRIDGE_BEARER=<48-char-token>
```

### 6. Validate
```bash
~/.openclaw/workspace/skills/kos-query-rds/query.sh ping
~/.openclaw/workspace/skills/kos-query-rds/query.sh search Robin
KOS_BRIDGE_INTEGRATION=1 pnpm -F @kos/service-openclaw-bridge exec vitest run test/integration/
```

## Live resources (2026-04-29)

| Resource | Identifier |
|---|---|
| Bridge Lambda | `kos-openclaw-bridge` |
| Bridge Function URL | `https://6h2rfuyl6bk3bu6rwwby2uh2dm0fplbq.lambda-url.eu-north-1.on.aws` |
| Bearer secret | `arn:aws:secretsmanager:eu-north-1:239541130189:secret:kos/openclaw-bridge-bearer` |
| DB secret | `arn:aws:secretsmanager:eu-north-1:239541130189:secret:kos/db/kos_openclaw_bridge` |
| DB user | `kos_openclaw_bridge` (SELECT-only) |
| Lambda role | `kos-openclaw-bridge-role` |
| VPC | `vpc-0b2c3a9f8b4d5e1c7` (inherited from KosNetwork) |
| Security group | `sg-0aaf935eabd3ee0d7` (RDS Proxy SG, reused) |

## Failure modes

- **"RDS proxy has no credentials for the role"** → step 4 not done. Add secret to proxy role policy + wait 60s.
- **403 from Function URL** → step 3 resource policy missing OR SigV4 creds wrong.
- **401 missing_bearer** → step 5 env file missing/wrong.
- **401 bad_bearer** → bearer token differs from Secrets Manager. Re-read secret or rotate.
- **502 on entity routes** → Lambda code broken. Check CloudWatch `/aws/lambda/kos-openclaw-bridge`.
