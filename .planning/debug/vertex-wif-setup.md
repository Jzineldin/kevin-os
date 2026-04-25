---
slug: vertex-wif-setup
status: parked
trigger: |
  Phase 6 Plan 06-05 dossier-loader needs Vertex AI Gemini auth from AWS Lambda
  to GCP. Initial plan was a service account JSON key in `kos/gcp-vertex-sa`,
  but the `tale-forge.app` GCP organisation enforces
  `iam.disableServiceAccountKeyCreation` (Google's "secure by default"
  baseline). SA JSON keys are blocked org-wide.

  The correct fix is Workload Identity Federation (WIF): AWS Lambda assumes
  its IAM role → exchanges the AWS STS token for a GCP access token via a
  Workload Identity Pool → calls Vertex. No long-lived JSON anywhere.
created: 2026-04-25
updated: 2026-04-25
---

# Vertex AI Workload Identity Federation — Setup Runbook

## Why this is parked

Phase 6 + 7 deploy 2026-04-25 shipped without the Vertex/Gemini dossier loader
because the GCP org policy blocks service account key creation. Phase 6's
*core* value (Azure semantic search + Granola pull + entity timeline) ships
fine without Gemini — Gemini is only for the rare deep 1M-token dossier loads.

When you (Kevin) have ~30 min and want to add full-dossier Gemini calls, work
through this runbook. Everything else is already in place: the dossier-loader
Lambda code exists in `services/dossier-loader/`, `integrations-vertex.ts` is
written but doesn't synthesize today (gated on `gcpProjectId` being set).

## Prereqs

- GCP project: `kevin-os-494418` (already created)
- Vertex AI API: enabled (already done)
- Service account: `kos-vertex-runner@kevin-os-494418.iam.gserviceaccount.com`
  with `roles/aiplatform.user` (already done)
- AWS account: 239541130189
- Lambda execution role (will be created by `wireDossierLoader` once
  `gcpProjectId` prop is supplied) — its ARN feeds into the WIF binding

## Plan

### 1. Create the Workload Identity Pool

```bash
# In Cloud Shell or with gcloud CLI logged in to kevin-os-494418
gcloud iam workload-identity-pools create kos-aws-pool \
  --project=kevin-os-494418 \
  --location=global \
  --display-name="KOS AWS Lambda federation"
```

### 2. Create the AWS provider on that pool

```bash
gcloud iam workload-identity-pools providers create-aws kos-aws-provider \
  --project=kevin-os-494418 \
  --location=global \
  --workload-identity-pool=kos-aws-pool \
  --account-id=239541130189 \
  --attribute-mapping="google.subject=assertion.arn,attribute.aws_role=assertion.arn.contains('assumed-role')?assertion.arn.extract('{account_arn}assumed-role/'):assertion.arn"
```

### 3. Bind the dossier-loader Lambda's IAM role to the SA

After running `cdk deploy KosIntegrations` once with `GCP_PROJECT_ID` set,
the Lambda role ARN will be visible. Bind it:

```bash
LAMBDA_ROLE_ARN=$(aws iam list-roles --query 'Roles[?contains(RoleName, `DossierLoader`)].Arn' --output text --region eu-north-1)

gcloud iam service-accounts add-iam-policy-binding \
  kos-vertex-runner@kevin-os-494418.iam.gserviceaccount.com \
  --project=kevin-os-494418 \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/$(gcloud config get-value project --format=json | jq -r .)/locations/global/workloadIdentityPools/kos-aws-pool/subject/${LAMBDA_ROLE_ARN}"
```

### 4. Generate the credential config JSON (no secret in it!)

```bash
gcloud iam workload-identity-pools create-cred-config \
  projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/kos-aws-pool/providers/kos-aws-provider \
  --service-account=kos-vertex-runner@kevin-os-494418.iam.gserviceaccount.com \
  --aws \
  --enable-imdsv2 \
  --output-file=kos-vertex-wif-config.json
```

The resulting JSON is **safe to commit** — it contains only public mappings,
no secret material.

### 5. Replace the `kos/gcp-vertex-sa` secret with the WIF config

```bash
aws secretsmanager put-secret-value \
  --secret-id kos/gcp-vertex-sa \
  --secret-string file://kos-vertex-wif-config.json \
  --region eu-north-1
```

### 6. Set `GCP_PROJECT_ID` and re-deploy

```bash
GCP_PROJECT_ID=kevin-os-494418 \
KEVIN_OWNER_ID=9e4be978-cc7d-571b-98ec-a1e92373682c \
  npx cdk deploy KosIntegrations --require-approval never
```

`wireDossierLoader` will now synthesize. The Lambda gets the WIF config JSON
mounted as `GOOGLE_APPLICATION_CREDENTIALS`-equivalent at runtime, and
`@google-cloud/vertexai` SDK auto-detects external account auth.

### 7. Smoke-test

```bash
aws lambda invoke \
  --function-name $(aws lambda list-functions --query 'Functions[?contains(FunctionName, `DossierLoader`)].FunctionName' --output text --region eu-north-1) \
  --payload '{"detail":{"entity_id":"<some-existing-entity-id>","capture_id":"smoke-test-001"}}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/dossier-out.json --region eu-north-1
cat /tmp/dossier-out.json
```

Expect: 200, response_text non-empty, tokens_input/output > 0,
cost_estimate_usd ~0.001-0.01 for a small dossier.

## Code already in place (no changes needed for WIF)

- `services/dossier-loader/src/vertex.ts` — uses `@google-cloud/vertexai` SDK
  which auto-detects ADC / external account credentials
- `services/dossier-loader/src/handler.ts` — calls `callGeminiWithCache()`
- `packages/cdk/lib/stacks/integrations-vertex.ts::wireDossierLoader` — wires
  the Lambda + IAM + EventBridge rule

The only difference between SA-JSON-key auth and WIF auth is what's stored
in the `kos/gcp-vertex-sa` secret. SDK handles both transparently.

## Estimated cost ceiling once enabled

Gemini 2.5 Pro: $1.25/M input (<200K), $2.50/M input (>200K), $10/M output.
Dossier load fires only on `agent.dossier.requested` events from the resolver
when full-context is needed (`load_full_dossier=true` in the agent reasoning).
Cap-aware: `cap_table` enforces 3 deep loads per day max → ~$0.30-1.00/day
worst case at v1 volume.
