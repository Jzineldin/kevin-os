# EmailEngine Operator Runbook (Phase 4 / Plan 04-03)

End-to-end operator playbook for deploying EmailEngine on the existing
`kos-cluster` Fargate cluster, registering both Gmail accounts via IMAP IDLE,
and running the 7-day zero-auth-failure soak that closes Gate 3 of Phase 4.

## Architecture summary

EmailEngine is a self-hosted IMAP push gateway that holds a persistent IMAP
IDLE connection per registered account and POSTs `messageNew` events to a
caller-supplied webhook. KOS deploys it as:

- **One Fargate task** (ARM64, 1 vCPU, 2 GB) on the existing `kos-cluster`,
  `desiredCount=1`. EmailEngine **forbids horizontal scaling** — its Redis
  state store is single-writer and concurrent processes corrupt IMAP state.
- **One ElastiCache Serverless Redis** (`kos-emailengine-redis`, ~$10/mo idle)
  in PRIVATE_WITH_EGRESS subnets. Security group ingress on :6379 is restricted
  to the EmailEngine task SG only.
- **emailengine-webhook Lambda** (Function URL, authType=NONE; the
  `X-EE-Secret` header — verified via constant-time compare against
  `kos/emailengine-webhook-secret` — is the auth boundary).
- **emailengine-admin Lambda** (Function URL, authType=AWS_IAM; only operator
  IAM creds can invoke).
- **Cloud Map private DNS** registers the EE service as
  `emailengine.kos-internal.local:3000`. The admin Lambda dials this internal
  hostname; the EmailEngine REST API has no public ingress.
- **CloudWatch log group** `/ecs/emailengine` (30-day retention) plus a metric
  filter that surfaces the `KOS::EmailEngineAuthFailures` count for the soak
  gate.

Steady-state cost: ~$45/mo (Fargate $35.91 + ElastiCache Serverless $10 +
license amortized $8 + Lambdas <$1).

## Prereqs (NOT automated)

These steps must be completed BEFORE flipping `enableEmailEngine=true` in the
CDK app props. Deploying without them would burn the EmailEngine 14-day trial
silently and crash IMAP IDLE on cold start.

### 1. Procure an EmailEngine license

EmailEngine is source-available with a 14-day trial; production use requires
a paid license (~$99/yr at <https://postalsys.com/emailengine>).

1. Visit <https://postalsys.com/emailengine> and purchase a self-hosted
   license. Save the license string (~512-char base64 blob).
2. Note the license expiry date — set a calendar reminder 30 days before
   it lapses. License expiry **silently degrades** IMAP IDLE to 15-min
   polling; there is no upstream alarm.

### 2. Generate Gmail app passwords for both accounts

Both accounts must have 2-Step Verification enabled. Gmail app passwords are
the only IMAP-compatible credential Google supports for personal accounts.

For each account (kevin.elzarka@gmail.com, kevin@tale-forge.app):

1. Sign into the account at <https://myaccount.google.com>.
2. Navigate to **Security** → **2-Step Verification** → **App passwords**.
3. Create a new app password labelled `KOS-EmailEngine-2026` (or similar).
4. Copy the 16-char password (format `<APP-PWD>`). Store it
   securely — Google shows it once.

Rotate these app passwords every 90 days. The 7-day soak gate (below) will
catch silent auth failures if a password is invalidated.

### 3. Seed the 5 EmailEngine secrets

`scripts/seed-secrets.sh` walks through each placeholder. For Plan 04-03:

```bash
# License key (single string)
aws secretsmanager put-secret-value \
  --secret-id kos/emailengine-license-key \
  --secret-string "<paste the EmailEngine license here>"

# Webhook X-EE-Secret (random 64-char hex)
aws secretsmanager put-secret-value \
  --secret-id kos/emailengine-webhook-secret \
  --secret-string "$(openssl rand -hex 32)"

# EmailEngine REST API key (random 64-char hex)
aws secretsmanager put-secret-value \
  --secret-id kos/emailengine-api-key \
  --secret-string "$(openssl rand -hex 32)"

# IMAP credentials per account (JSON shape — schema enforced by admin Lambda)
aws secretsmanager put-secret-value \
  --secret-id kos/emailengine-imap-kevin-elzarka \
  --secret-string '{"email":"kevin.elzarka@gmail.com","app_password":"<PASTE-16-CHAR-APP-PASSWORD>"}'

aws secretsmanager put-secret-value \
  --secret-id kos/emailengine-imap-kevin-taleforge \
  --secret-string '{"email":"kevin@tale-forge.app","app_password":"<PASTE-16-CHAR-APP-PASSWORD>"}'
```

Verify each secret is no longer the literal `PLACEHOLDER`:

```bash
for s in license-key webhook-secret api-key imap-kevin-elzarka imap-kevin-taleforge; do
  v=$(aws secretsmanager get-secret-value --secret-id kos/emailengine-$s \
    --query SecretString --output text)
  if [ "$v" = "PLACEHOLDER" ]; then echo "FAIL: $s still PLACEHOLDER"; else echo "ok: $s"; fi
done
```

## Deploy steps

### 4. Flip `enableEmailEngine=true` and deploy

In `packages/cdk/bin/kos.ts`, set `enableEmailEngine: true` in the
`IntegrationsStack` props (the helper synthesises nothing without it):

```typescript
new IntegrationsStack(app, 'KosIntegrations', {
  // ...existing props...
  enableEmailEngine: true,
  ecsCluster: data.ecsCluster,
  emailEngineLicenseSecret: data.emailEngineLicenseSecret,
  emailEngineImapElzarkaSecret: data.emailEngineImapElzarkaSecret,
  emailEngineImapTaleforgeSecret: data.emailEngineImapTaleforgeSecret,
  emailEngineWebhookSecret: data.emailEngineWebhookSecret,
  emailEngineApiKeySecret: data.emailEngineApiKeySecret,
});
```

Then deploy:

```bash
cd packages/cdk && npx cdk deploy KosIntegrations --require-approval never
```

Expected duration: ~4 min (Fargate task + ElastiCache Serverless + 2 Lambdas).

### 5. Wait for ElastiCache Serverless ready

```bash
aws elasticache describe-serverless-caches \
  --serverless-cache-name kos-emailengine-redis \
  --query 'ServerlessCaches[0].Status' --output text
# Expect: "available"
```

### 6. Wait for Fargate task HEALTHY

```bash
aws ecs describe-services --cluster kos-cluster \
  --services $(aws ecs list-services --cluster kos-cluster \
    --query "serviceArns[?contains(@, 'EmailEngineService')]|[0]" --output text) \
  --query 'services[0].{Desired:desiredCount,Running:runningCount,Pending:pendingCount}'
# Expect: Desired=1, Running=1, Pending=0
```

Tail the EE container logs:

```bash
aws logs tail /ecs/emailengine --follow
# Expect: "EmailEngine listening on port 3000"
```

### 7. Register both Gmail accounts

```bash
export EMAILENGINE_ADMIN_URL=$(aws cloudformation describe-stacks \
  --stack-name KosIntegrations \
  --query "Stacks[0].Outputs[?OutputKey=='EmailEngineAdminUrl'].OutputValue" \
  --output text)
export IMAP_SECRET_ARN_ELZARKA=$(aws secretsmanager describe-secret \
  --secret-id kos/emailengine-imap-kevin-elzarka --query ARN --output text)
export IMAP_SECRET_ARN_TALEFORGE=$(aws secretsmanager describe-secret \
  --secret-id kos/emailengine-imap-kevin-taleforge --query ARN --output text)

node scripts/configure-emailengine-accounts.mjs
```

The script invokes the `EmailEngineAdmin` Lambda twice (once per account) using
your operator IAM credentials (SigV4-signed via the AWS CLI). EmailEngine
responds with the account state; expect HTTP 200 + `{"state":"connecting"}`.

### 8. Verify IMAP IDLE established

```bash
aws logs tail /ecs/emailengine --follow --since 5m
# Expect, within ~30s per account:
#   account=kevin-elzarka state=connecting
#   account=kevin-elzarka state=connected
#   account=kevin-elzarka IMAP IDLE established
#   (same for kevin-taleforge)
```

### 9. End-to-end test

Send a test email from a different address to `kevin@tale-forge.app`. Within
~10 seconds you should see in `/ecs/emailengine`:

```
account=kevin-taleforge event=messageNew uid=<n>
webhook POST -> https://<webhook-fn-id>.lambda-url.eu-north-1.on.aws/
webhook response 200
```

And on the `kos.capture` EventBridge bus:

```bash
aws logs tail /aws/lambda/KosIntegrations-EmailEngineWebhook --since 5m
# Expect: "capture.received" emitted with kind=email_inbox channel=email-inbox
```

## 7-day zero-auth-failure soak (Phase 4 Gate 3 criterion)

The CDK helper provisions a CloudWatch metric filter on `/ecs/emailengine`
matching `"auth failure"` → metric `KOS::EmailEngineAuthFailures`. Check daily
for 7 consecutive days starting the day after registration:

```bash
aws cloudwatch get-metric-statistics \
  --namespace KOS \
  --metric-name EmailEngineAuthFailures \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 86400 \
  --statistics Sum
```

**Expected:** `Sum: 0` for all 7 daily buckets. Any non-zero day fails the
gate; rotate Gmail app passwords + re-run the registration script and start
the 7-day window over.

## Incident response

### IMAP IDLE drops mid-session

EmailEngine auto-reconnects with exponential backoff. Watch for reconnect
storms:

```bash
aws logs filter-log-events --log-group-name /ecs/emailengine \
  --filter-pattern '"IDLE established"' \
  --start-time $(($(date +%s) - 3600))000 | jq '.events | length'
# Expect <= 4 reconnects per account per hour. >10 = investigate.
```

### License expiry (silent IMAP IDLE → polling degradation)

Add a CloudWatch alarm on the `auth failure` metric (any non-zero in 1 hour):

```bash
aws cloudwatch put-metric-alarm --alarm-name kos-emailengine-license-expiry \
  --metric-name EmailEngineAuthFailures --namespace KOS \
  --statistic Sum --period 3600 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 --treat-missing-data notBreaching \
  --alarm-actions <SNS-topic-arn-for-kevin-pager>
```

### Fargate task restart

ECS automatically respawns failed tasks. IMAP state is in Redis (survives the
task restart) so registered accounts auto-reconnect on the new task. There
will be ~30s of webhook silence per account during restart — acceptable for
single-user volume.

### App password revoked / rotated

1. Generate a new app password in Google Security console.
2. Update the secret:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id kos/emailengine-imap-kevin-elzarka \
     --secret-string '{"email":"kevin.elzarka@gmail.com","app_password":"NEW PASSWORD"}'
   ```
3. Re-register the account so EE picks up the new credentials:
   ```bash
   node scripts/configure-emailengine-accounts.mjs
   # The admin Lambda's POST /v1/account UPDATES an existing account.
   ```
4. Restart the soak window if the rotation was due to an auth failure.

## What NOT to do

- **Do not** scale `EmailEngineService` past `desiredCount=1`. EmailEngine's
  Redis-backed state store cannot tolerate concurrent writers. The CDK test
  asserts `DesiredCount: 1`; if you ever need to "scale" EmailEngine, you are
  wrong — re-read the upstream docs.
- **Do not** expose the EmailEngine REST API publicly via an ALB. Cloud Map
  private DNS + the admin Lambda are the only correct ingress paths.
- **Do not** seed the 5 secrets with the literal `PLACEHOLDER` and deploy.
  The webhook + admin handlers fail closed on PLACEHOLDER values, but the
  Fargate task will still start and burn billable runtime.
- **Do not** put SMTP credentials into the `kos/emailengine-imap-*` secrets.
  KOS sends outbound mail via SES; EmailEngine only watches IMAP IDLE for
  inbound.
