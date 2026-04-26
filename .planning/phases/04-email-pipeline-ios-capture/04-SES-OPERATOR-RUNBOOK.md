# SES Inbound Operator Runbook (Phase 4 Plan 04-02 / CAP-03)

All steps below run **out-of-band** by the operator (Kevin) before the first
forwarded email arrives at `forward@kos.tale-forge.app`. They are NOT
automated via CDK in v1 because of region asymmetry — SES inbound only
operates in eu-west-1 in our region set, and the rest of KOS is pinned to
eu-north-1 (D-13). Modelling the eu-west-1 bucket + receiving rule in CDK
would force a second stack in a different region. We chose the simpler
operator-prerequisite path; Phase 7+ may revisit (deferred-items.md).

The CDK side provisions only the **Lambda + IAM grants** in eu-north-1
(see `packages/cdk/lib/stacks/integrations-ses-inbound.ts`). Activate with
`KOS_ENABLE_SES_INBOUND=true cdk deploy KosIntegrations` once steps 1–6
below are complete.

## Prerequisites

- AWS CLI v2 with credentials for the KOS account.
- DNS control over `tale-forge.app` (Cloudflare or wherever the zone lives).
- Kevin's account number (referred to as `<account>` below — substitute the
  literal 12-digit ID).

## Steps

### 1. Verify the receiving domain in SES (eu-west-1)

```bash
aws ses verify-domain-identity --region eu-west-1 --domain kos.tale-forge.app
aws ses verify-domain-dkim --region eu-west-1 --domain kos.tale-forge.app
```

Both calls return TXT / CNAME records. Add them to the `tale-forge.app` DNS
zone. DKIM publishes 3 CNAMEs (`<token1>._domainkey.kos.tale-forge.app`
etc.). Verification typically completes within 10 minutes of DNS publish.

Confirm:

```bash
aws ses get-identity-verification-attributes --region eu-west-1 \
  --identities kos.tale-forge.app
# VerificationStatus must be "Success"
```

### 2. Create the inbound bucket `kos-ses-inbound-euw1-<account>` in eu-west-1

```bash
aws s3api create-bucket \
  --bucket kos-ses-inbound-euw1-<account> \
  --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1
```

The CDK Lambda's IAM policy uses the wildcard pattern
`arn:aws:s3:::kos-ses-inbound-euw1-*/incoming/*`, so the per-account suffix
is fine. Stick to that prefix.

### 3. Apply the bucket policy that allows SES PutObject

Save the following as `bucket-policy.json` (substitute `<account>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSESPuts",
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::kos-ses-inbound-euw1-<account>/incoming/*",
      "Condition": {
        "StringEquals": { "AWS:SourceAccount": "<account>" }
      }
    }
  ]
}
```

Apply:

```bash
aws s3api put-bucket-policy \
  --bucket kos-ses-inbound-euw1-<account> \
  --policy file://bucket-policy.json
```

The `AWS:SourceAccount` condition is the T-04-SES-02 mitigation — without it
any SES principal in any account could write to the bucket.

### 4. Lifecycle policy: Glacier-transition at 30 d, expire at 90 d

`lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "incoming-archival",
      "Status": "Enabled",
      "Filter": { "Prefix": "incoming/" },
      "Transitions": [{ "Days": 30, "StorageClass": "GLACIER" }],
      "Expiration": { "Days": 90 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket kos-ses-inbound-euw1-<account> \
  --lifecycle-configuration file://lifecycle.json
```

### 5. Add the MX record on `kos.tale-forge.app`

```
kos.tale-forge.app.   MX   10 inbound-smtp.eu-west-1.amazonaws.com.
```

(In Cloudflare: Type=MX, Name=kos, Mail server=`inbound-smtp.eu-west-1.amazonaws.com`,
Priority=10, TTL=Auto.) Propagation typically completes within 5–15 minutes.

Verify:

```bash
dig +short MX kos.tale-forge.app
# 10 inbound-smtp.eu-west-1.amazonaws.com.
```

### 6. Create the SES receiving rule set + rule

The Lambda ARN below comes from the CloudFormation output of `KosIntegrations`
once you've deployed with `KOS_ENABLE_SES_INBOUND=true`. Run step 7 first to
get the ARN, then return here.

```bash
aws ses create-receipt-rule-set \
  --region eu-west-1 \
  --rule-set-name kos-default

aws ses create-receipt-rule \
  --region eu-west-1 \
  --rule-set-name kos-default \
  --rule '{
    "Name": "ses-to-kos-forward",
    "Enabled": true,
    "ScanEnabled": true,
    "Recipients": ["forward@kos.tale-forge.app"],
    "Actions": [
      {
        "S3Action": {
          "BucketName": "kos-ses-inbound-euw1-<account>",
          "ObjectKeyPrefix": "incoming/"
        }
      },
      {
        "LambdaAction": {
          "FunctionArn": "arn:aws:lambda:eu-north-1:<account>:function:KosIntegrations-SesInbound...",
          "InvocationType": "Event"
        }
      }
    ]
  }'

aws ses set-active-receipt-rule-set \
  --region eu-west-1 \
  --rule-set-name kos-default
```

`ScanEnabled: true` runs SPF + DKIM + spam scoring — outputs are surfaced
in the SES headers so email-triage can use them in classification later.

### 7. Deploy the CDK Lambda

Once steps 1–5 are done (and you have the bucket name + an account ID for
the IAM SourceAccount condition), deploy with the activation flag:

```bash
KOS_ENABLE_SES_INBOUND=true \
KEVIN_OWNER_ID=9e4be978-cc7d-571b-98ec-a1e92373682c \
pnpm --filter @kos/cdk exec cdk deploy KosIntegrations
```

Read the `KosIntegrations-SesInbound...` Lambda ARN from the deploy output.
Plug it into step 6 if you didn't already.

### 8. Smoke test

Send a test email from any external account (Gmail works) to
`forward@kos.tale-forge.app`. Then check:

```bash
# 1. The S3 object landed:
aws s3 ls s3://kos-ses-inbound-euw1-<account>/incoming/ --region eu-west-1

# 2. The Lambda fired:
aws logs tail /aws/lambda/KosIntegrations-SesInbound... \
  --region eu-north-1 --since 5m

# 3. capture.received was emitted (Phase 2 triage picks it up next):
aws logs filter-log-events \
  --region eu-north-1 \
  --log-group-name /aws/events/kos.capture \
  --filter-pattern '"capture.received"' \
  --start-time $(($(date +%s%3N) - 300000))
```

You should see:
- An object at `incoming/<random-message-id>` in the bucket.
- A Lambda log line `processed 1 records`.
- A capture.received event with `channel: "email-forward"` on
  `kos.capture` (Phase 2 triage will then route it).

## Gotchas

- **DNS propagation lag.** MX changes can take up to 30 minutes in rare
  cases; if step 8 fails with no S3 objects appearing, give the MX another
  10 minutes before debugging.
- **Sandbox does NOT apply to inbound.** SES inbound is not subject to the
  outbound sandbox, so the first real email works immediately after rule
  activation.
- **AccessDenied in Lambda logs.** If the Lambda fails to invoke with
  `AccessDenied`, the SES rule's LambdaAction targets a Lambda whose
  `AllowSesInvoke` permission's `SourceAccount` doesn't match this account.
  Re-deploy `KosIntegrations` (the CDK helper auto-derives `SourceAccount`
  from `Stack.of(scope).account`).
- **Duplicate captures from SES retries.** Expected — the handler derives
  `capture_id` from sha256(Message-ID), so two invocations for the same
  email produce identical event details. Phase 2 triage dedupes on
  `capture_id`.
- **Email > 256 KB.** SES caps inbound at 40 MB but the EventBridge detail
  envelope is bounded at 256 KB. The handler does not currently truncate
  body fields; if a forwarded email's body_text exceeds that, EventBridge
  rejects with `ValidationException`. Plan 04-04 (`email-triage`) tracks
  the body-size truncation hardening.

## Reverting

Undo in reverse order:

```bash
# 1. Disable the receiving rule:
aws ses update-receipt-rule \
  --region eu-west-1 \
  --rule-set-name kos-default \
  --rule '{"Name":"ses-to-kos-forward","Enabled":false}'

# 2. Remove the MX record from DNS.

# 3. Tear down the Lambda:
KOS_ENABLE_SES_INBOUND=false pnpm --filter @kos/cdk exec cdk deploy KosIntegrations

# 4. Delete bucket + rule set:
aws s3 rb s3://kos-ses-inbound-euw1-<account> --force --region eu-west-1
aws ses delete-receipt-rule-set --region eu-west-1 --rule-set-name kos-default
```

The capture.received contract (`@kos/contracts` `CaptureReceivedEmailForwardSchema`)
remains in place even after teardown — it's harmless if no events are emitted.
