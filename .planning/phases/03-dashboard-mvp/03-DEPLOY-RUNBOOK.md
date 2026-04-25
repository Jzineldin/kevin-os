# Phase 3 Deploy Runbook — kos-dashboard

> Kevin-driven manual sequence. Plan 03-13 ships the scripts and docs
> that make each step a single command or a tight doc reference.
>
> **Execute steps in order.** Each step has an explicit "verify" line.
> Do not proceed to the next step until the current one verifies.
>
> **No destructive operations** are performed without a confirm prompt.

---

## 0. Preflight

Confirm you're on the right AWS account + profile and the KOS tree is green.

```bash
# Inside the KOS repo root (monorepo):

# AWS profile sanity
aws sts get-caller-identity --output table
# Expected: your KOS account; region defaults to eu-north-1.

aws configure list
# Expected: region = eu-north-1

# Vercel login sanity
vercel whoami
# Expected: kevin-elzarka (or whichever scope owns the kos-dashboard project)

# Tree sanity: typecheck + build the dashboard workspace
pnpm typecheck
pnpm --filter @kos/dashboard build
# Expected: both exit 0 (build emits .next + public/sw.js via Serwist).

# Sanity: CDK tests green
pnpm --filter @kos/cdk test --run
# Expected: 0 fail on dashboard-stack.test.ts (18/18 pass).
```

**Verify:** `aws sts get-caller-identity` shows the KOS account and
`vercel whoami` shows `kevin-elzarka`. `pnpm typecheck` exits 0.

---

## 1. Author the Bearer token (single-user login secret)

Generate a long random string and store it in Secrets Manager. This is
the token Kevin pastes on the `/login` page.

```bash
# Generate a 64-char random UUID pair (no ambiguity with base64 special chars):
TOKEN=$(node -e "console.log(crypto.randomUUID()+crypto.randomUUID())")
echo "Save this securely (will not be shown again): $TOKEN"

# Write to Secrets Manager as JSON { "token": "<value>" } (sync-vercel-env.ts
# accepts either JSON or raw string):
aws secretsmanager put-secret-value \
  --secret-id kos/dashboard-bearer-token \
  --secret-string "{\"token\":\"$TOKEN\"}" \
  --region eu-north-1

unset TOKEN  # do not let it linger in shell history
```

**Verify:**

```bash
aws secretsmanager get-secret-value \
  --secret-id kos/dashboard-bearer-token \
  --region eu-north-1 \
  --query 'SecretString' --output text | head -c 20
# Expected: starts with `{"token":"` (NOT `{"placeholder":true}`).
```

---

## 2. Create the Sentry project + store the DSN

1. In Sentry SaaS UI (kevin@tale-forge.app), create a new project:
   - Platform: Next.js
   - Team: (your default)
   - Project name: `kos-dashboard`

2. Copy the DSN from project settings (format:
   `https://<public_key>@o<org_id>.ingest.sentry.io/<project_id>`).

3. Store in Secrets Manager as a bare URL string:

```bash
aws secretsmanager put-secret-value \
  --secret-id kos/sentry-dsn-dashboard \
  --secret-string "https://<paste_dsn_here>" \
  --region eu-north-1
```

**Verify:**

```bash
aws secretsmanager get-secret-value \
  --secret-id kos/sentry-dsn-dashboard \
  --region eu-north-1 \
  --query 'SecretString' --output text | head -c 10
# Expected: starts with "https://"
```

---

## 3. Build the Fargate relay Docker image

`cdk deploy` synthesises the asset manifest and invokes Docker Buildx
for the ARM64 image. Pre-build locally to surface any Dockerfile
regressions outside the slower cdk loop.

```bash
cd services/dashboard-listen-relay
docker buildx build --platform linux/arm64 -t kos-listen-relay:latest . --load
cd ../..
```

**Verify:** `docker images kos-listen-relay:latest --format '{{.Size}}'`
reports a sensible size (~200-350 MB).

---

## 4. Deploy the CDK DashboardStack

```bash
pnpm --filter @kos/cdk build
pnpm --filter @kos/cdk exec cdk deploy KosDashboard --require-approval=never
```

Deploy typically takes 4-8 minutes (Lambda + Fargate + NLB + ECR asset
push). On success, CloudFormation prints the 6 outputs:

```
KosDashboard.DashboardApiFunctionUrl     = https://<id>.lambda-url.eu-north-1.on.aws/
KosDashboard.RelayProxyFunctionUrl       = https://<id>.lambda-url.eu-north-1.on.aws/
KosDashboard.DashboardApiCallerUserArn   = arn:aws:iam::<acct>:user/kos-dashboard-caller
KosDashboard.DashboardRelayCallerUserArn = arn:aws:iam::<acct>:user/kos-dashboard-relay-caller
KosDashboard.FargateClusterName          = kos-cluster
KosDashboard.DashboardBearerSecretArn    = arn:aws:secretsmanager:eu-north-1:<acct>:secret:kos/dashboard-bearer-token-XXXXXX
```

**Verify:**

```bash
aws cloudformation describe-stacks \
  --stack-name KosDashboard \
  --region eu-north-1 \
  --query 'Stacks[0].StackStatus' --output text
# Expected: CREATE_COMPLETE or UPDATE_COMPLETE

aws cloudformation describe-stacks \
  --stack-name KosDashboard \
  --region eu-north-1 \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
# Expected: 6 output rows.
```

---

## 5. Create IAM access keys for the 2 caller users

CDK created `kos-dashboard-caller` and `kos-dashboard-relay-caller`
with narrow `lambda:InvokeFunctionUrl` policies, but NOT their access
keys (access-key rotation should be manual, not tied to every stack
deploy).

```bash
# Create + store dashboard-api caller keys
aws iam create-access-key --user-name kos-dashboard-caller \
  --region eu-north-1 > /tmp/caller-keys.json
aws secretsmanager put-secret-value \
  --secret-id kos/dashboard-caller-access-keys \
  --secret-string file:///tmp/caller-keys.json \
  --region eu-north-1
rm /tmp/caller-keys.json

# (If the DashboardStack also provisioned kos-dashboard-relay-caller with a
# separate access-keys secret, repeat for it. Plan 03-04 notes this is a
# separate Secret; verify the secret name before running:
#   aws secretsmanager list-secrets --query "SecretList[?starts_with(Name,'kos/dashboard-')].Name" --output text
# )
```

**Verify:**

```bash
aws secretsmanager get-secret-value \
  --secret-id kos/dashboard-caller-access-keys \
  --region eu-north-1 \
  --query 'SecretString' --output text | python -c 'import json,sys;d=json.load(sys.stdin);print("AccessKey" in d.get("AccessKey",{}) or "AccessKeyId" in d)'
# Expected: True
```

---

## 6. Apply migrations 0007-0010 to RDS

Plan 03-01 authored the 4 SQL migrations (`entity_merge_audit`,
`inbox_index`, etc.) but did not apply them. Choose ONE of the
following paths to push the schema to RDS:

### Option A (preferred): One-shot migrations Lambda

If the DashboardStack or a prior plan provisioned a
`dashboard-migrations` Lambda (Plan 03-05 choice), invoke it:

```bash
aws lambda invoke \
  --function-name dashboard-migrations \
  --region eu-north-1 \
  /dev/null
# Expected: StatusCode=200, no FunctionError field.
```

### Option B: Bastion + drizzle-kit push

Redeploy DataStack with `-c bastion=true` to temporarily provision the
Phase 1 bastion host, then tunnel to RDS Proxy and push schema:

```bash
# Provision bastion (ephemeral; tear down after schema push)
pnpm --filter @kos/cdk exec cdk deploy KosData --context bastion=true \
  --require-approval=never

# Start Session Manager port-forward to the RDS Proxy endpoint
aws ssm start-session \
  --target <BASTION_INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<rds-proxy-host>"],"portNumber":["5432"],"localPortNumber":["5432"]}' &
SESSION_PID=$!
sleep 3

# Push with drizzle-kit via RDS IAM auth
export DATABASE_URL="postgresql://dashboard_api:$(
  aws rds generate-db-auth-token --hostname localhost --port 5432 \
    --username dashboard_api --region eu-north-1
)@localhost:5432/kos?sslmode=require"
pnpm --filter @kos/db exec drizzle-kit push

# Cleanup
kill $SESSION_PID
unset DATABASE_URL

# Tear down bastion
pnpm --filter @kos/cdk exec cdk deploy KosData --require-approval=never
```

### Option C: Local via SSM direct port-forward (no bastion)

If RDS Proxy has a VPC endpoint / the session manager can reach it
directly, skip bastion provisioning and just open the port-forward
to the RDS Proxy directly. See AWS docs for "SSM Port forwarding
to a remote host".

**Verify (any option):**

```bash
# Via bastion-connected psql OR the dashboard-api Lambda query route,
# assert the 4 new tables exist:
SELECT relname FROM pg_class
WHERE relname IN ('entity_merge_audit', 'inbox_index', 'entity_timeline_mv', 'dashboard_activity_log')
ORDER BY relname;
# Expected: 4 rows (or whichever exact table set 0007-0010 create).
```

---

## 7. Link the Vercel project

```bash
cd apps/dashboard
vercel link --project kos-dashboard --yes
cd ../..
```

**Verify:** `cat apps/dashboard/.vercel/project.json` shows
`"projectId": "prj_..."` and `"orgId": "team_..."`.

---

## 8. Sync env vars to Vercel

This is where the Task 1 script runs. It reads the secrets + CFN outputs
and writes 9 env vars across production + preview + development.

```bash
# Dry run first — no mutations; prints name + length + SHA-256 prefix only
pnpm sync-vercel -- --dry-run

# Review the output. If it looks right, run for real (interactive confirm):
pnpm sync-vercel

# Or fully non-interactive (CI-compatible):
pnpm sync-vercel -- --yes
```

**Verify:**

```bash
vercel env ls production
# Expected: 9 entries (KOS_DASHBOARD_API_URL, KOS_DASHBOARD_RELAY_URL,
# KOS_DASHBOARD_BEARER_TOKEN, AWS_ACCESS_KEY_ID_DASHBOARD,
# AWS_SECRET_ACCESS_KEY_DASHBOARD, AWS_REGION, KOS_OWNER_ID,
# NEXT_PUBLIC_SENTRY_DSN, SENTRY_DSN).
```

---

## 9. Deploy to Vercel production

```bash
vercel deploy apps/dashboard --prod
```

Vercel prints the deployment URL on success, e.g.
`https://kos-dashboard-kevin-elzarka.vercel.app`. Copy this URL — you
need it for step 10.

**Verify:**

```bash
curl -sI https://kos-dashboard-kevin-elzarka.vercel.app/ | head -3
# Expected: HTTP/2 302  (unauthenticated redirect to /login)
```

---

## 10. Run the goal-backward verifier

This is the Task 2 script. It exercises each of the 6 ROADMAP Phase 3
success criteria and writes a JSON report.

```bash
# Recall the token from step 1 (or re-read from Secrets Manager):
export KOS_DASHBOARD_BEARER_TOKEN=$(
  aws secretsmanager get-secret-value \
    --secret-id kos/dashboard-bearer-token \
    --region eu-north-1 \
    --query 'SecretString' --output text | python -c 'import sys,json;print(json.load(sys.stdin)["token"])'
)

# Export the deployment URL + seed entity IDs (pick any 2 real entities
# from your Notion Entities DB — script is read-only for SC2/SC3):
export DEPLOY_URL="https://kos-dashboard-kevin-elzarka.vercel.app"
export SEED_ENTITY_ID="<target-entity-uuid>"
export SEED_SOURCE_ID="<source-entity-uuid>"

# Run:
pnpm verify-phase-3
```

Expected final summary: `Total: 6  PASS: 6  FAIL: 0  SKIP: 0`.

If any criterion FAILs, read the `detail` column + check
`.planning/phases/03-dashboard-mvp/.ephemeral/verify-report.json`.
Fix the underlying issue, re-deploy (step 9) if code changed, re-run.

---

## 11. Manual device sign-off (per 03-VALIDATION.md Manual-Only)

These three checks require physical devices and cannot be automated.
Perform each and tick the box.

### Android Chrome PWA install (UI-05)

- [ ] Open Chrome on an Android device
- [ ] Navigate to `https://kos-dashboard-kevin-elzarka.vercel.app`
- [ ] Log in with the Bearer token
- [ ] Open Chrome menu -> "Install app" (or tap the install icon in
      the address bar)
- [ ] Confirm "Kevin OS" icon appears on the home screen
- [ ] Tap the icon -> app launches in **standalone mode** (no Chrome
      URL bar visible)

### iOS Safari Add-to-Home-Screen (UI-05)

- [ ] Open Safari on an iOS 17+ device
- [ ] Navigate to `https://kos-dashboard-kevin-elzarka.vercel.app`
- [ ] Log in with the Bearer token
- [ ] Tap Share -> "Add to Home Screen"
- [ ] Confirm icon appears on the home screen
- [ ] Tap the icon -> **confirm it opens in Safari with the URL bar
      visible (NOT standalone)** — this is the EU DMA regression per
      D-32 and is the correct, expected behaviour.

### Desktop Chrome or Edge PWA install (UI-05)

- [ ] Open Chrome or Edge on macOS or Windows
- [ ] Navigate to `https://kos-dashboard-kevin-elzarka.vercel.app`
- [ ] Log in with the Bearer token
- [ ] Click the install icon in the address bar
- [ ] Confirm the app opens in a **standalone window** with no browser
      chrome

---

## 12. Full-loop smoke test (optional but recommended)

Logged in on the deployed URL:

- [ ] `/today` renders: sidebar + topbar + Top 3 Priorities + Drafts
      to review + Dropped + Composer + today/tomorrow calendar slice
- [ ] `⌘K` opens the command palette; typing an entity name jumps to
      `/entities/<id>`
- [ ] `/entities/<id>` renders the AI "What you need to know" block +
      timeline + linked projects/tasks
- [ ] `/inbox` supports J/K navigation + Enter/E/S actions
- [ ] `/calendar` renders the week view
- [ ] Send a voice capture from Telegram (Phase 2 pipeline) -> the
      item appears in `/inbox` within ~25s via SSE (no manual refresh)
- [ ] Browser DevTools Network tab shows `/api/stream` held open with
      `content-type: text/event-stream`
- [ ] Vercel Analytics dashboard (in Vercel UI) shows at least 1
      session from this verification (starts the Gate 4 counter)

---

## Troubleshooting

### `cdk deploy KosDashboard` fails with `ResourceNotFoundException`

The DashboardStack depends on NetworkStack, DataStack, EventsStack,
IntegrationsStack. Confirm all 4 are in `CREATE_COMPLETE` before
deploying DashboardStack:

```bash
for s in KosNetwork KosData KosEvents KosIntegrations; do
  aws cloudformation describe-stacks --stack-name $s --region eu-north-1 \
    --query 'Stacks[0].StackStatus' --output text
done
```

### `pnpm sync-vercel` fails with "still contains the placeholder sentinel"

Re-run step 1 (bearer), step 2 (Sentry), or step 5 (caller keys) —
one of the Secrets still holds the `{"placeholder":true}` stub from
the initial stack deploy. The sync script refuses to propagate stubs
to Vercel.

### `pnpm verify-phase-3` SC1 fails with 401 on /api/auth/login

The Vercel env `KOS_DASHBOARD_BEARER_TOKEN` is out of sync with the
Secret. Re-run step 8 (sync-vercel) with `--yes`.

### `pnpm verify-phase-3` SC4 fails with "content-type=text/html"

The `/api/stream` route returned the middleware redirect HTML instead
of the SSE stream. Confirm the cookie is being set on login (step 10's
`login()` helper writes it) and re-run with `--verbose`.

### `pnpm verify-phase-3` SC2 > 500ms consistently

Inspect `/api/entities/<id>/timeline?limit=50` response time in
isolation:

```bash
time curl -sH "cookie: $(pnpm verify-phase-3 -- --verbose 2>&1 | grep 'cookie length')" \
  "$DEPLOY_URL/api/entities/$SEED_ENTITY_ID/timeline?limit=50" > /dev/null
```

Common culprits: missing RDS index on `entity_timeline_mv(entity_id,
event_ts)`; Fargate NLB cold-start latency. Warm up with a few calls
before measuring.

### Android install menu item missing

Chrome requires HTTPS + valid manifest + sw.js + 2 min of engagement
before the install prompt appears. Reload, poke around for 2-3 min,
then re-check the menu.

---

## Post-deploy cleanup

- Clear shell history of any raw Bearer tokens:
  `history -c && history -w`
- Rotate the Bearer token on a schedule (every 90d) by re-running
  step 1 + step 8 (sync-vercel).
- Tear down the bastion if you used Option B in step 6 (already
  covered in that step).

---

## Reference

- Plan: `.planning/phases/03-dashboard-mvp/03-13-PLAN.md`
- Sync script: `scripts/sync-vercel-env.ts` (`pnpm sync-vercel`)
- Verifier: `scripts/verify-phase-3.ts` (`pnpm verify-phase-3`)
- Env template: `apps/dashboard/.env.example`
- Vercel config: `apps/dashboard/vercel.json`
- Upstream summaries:
  - `03-04-SUMMARY.md` (DashboardStack CDK outputs)
  - `03-05-SUMMARY.md` (auth middleware + cookie contract)
  - `03-12-SUMMARY.md` (PWA manifest + sw.js + offline banner)
- Validation matrix: `03-VALIDATION.md` §Manual-Only Verifications
- Success criteria: `ROADMAP.md` §Phase 3 (6 items)
