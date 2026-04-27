# OpenClaw ↔ KOS — Credentials & Access Checklist

**Purpose:** every key, token, and secret OpenClaw needs to own KOS's backend. Written for Kevin's existing OpenClaw EC2 install. Each item says what it's for, where it currently lives in KOS, and exactly how to wire it into OpenClaw config.

**Last updated:** 2026-04-27

**Security posture:** start with read-only scopes for everything. Promote scope one service at a time as OpenClaw proves itself. All credentials below should live in `~/.openclaw/secrets/` on the OpenClaw EC2, NOT in the repo.

---

## Quick reference: what each credential does

| # | Credential | Needed for | Scope to grant first | Promote later to |
|---|---|---|---|---|
| 1 | Git/GitHub token | Clone + pull repo | `repo:read` | `repo:write` for feature branches |
| 2 | AWS IAM creds | CloudWatch logs, Lambda invoke, Secrets Manager read | Read-only | Deploy (scoped to dev stacks) |
| 3 | Postgres credentials | Read entity_index, propose to proposals table | `dashboard_api` (SELECT only) | `kos_agent_writer` (INSERT/UPDATE) |
| 4 | Notion integration token | Read Command Center, Today page, transcripts | Reuse existing | Same (already has read+write) |
| 5 | Google OAuth × 2 accounts | Gmail read, Calendar read | Existing scopes | Gmail send (already granted) |
| 6 | Telegram bot token | Handle `@zinkevbot` messages | Reuse existing | Same |
| 7 | Bedrock IAM access | Sonnet 4.6, Haiku 4.5 for agents | InvokeModel on inference profiles | Same |
| 8 | Anthropic API key (optional) | If using direct Anthropic, not Bedrock | API-level | — |
| 9 | Sentry DSN | Error tracking from OpenClaw operations | DSN write-only | — |
| 10 | Langfuse keys | LLM trace observability | Public+secret | — |
| 11 | Azure Search admin | Semantic memory backend (optional) | Admin | — |

---

## 1. Git / Repository access

**Purpose:** OpenClaw clones `kevin-os` and does `git pull` on a schedule (or on webhook). For any soft-gate write operations, commits + pushes to `openclaw-dev` branch.

**Option A — Personal Access Token (simplest):**

```bash
# Create at https://github.com/settings/tokens/new (classic) or
# https://github.com/settings/personal-access-tokens/new (fine-grained, preferred)
#
# Fine-grained scope:
#   Repository: jzineldin/kevin-os (or your fork)
#   Permissions:
#     Contents: Read + Write
#     Metadata: Read (required)
#     Pull requests: Read + Write (so it can open PRs to main)
#   NO access to: Actions, Secrets, Admin, Packages
#
# Expiration: 90 days. Set a calendar reminder to rotate.
```

Store in OpenClaw:
```bash
ssh openclaw-ec2
echo "<pat_xxx>" > ~/.openclaw/secrets/github.token
chmod 600 ~/.openclaw/secrets/github.token

# Use in git config:
git config --global credential.helper 'store --file ~/.openclaw/secrets/github.token'
```

**Option B — SSH deploy key (more surgical):**

```bash
# On OpenClaw EC2:
ssh-keygen -t ed25519 -f ~/.ssh/openclaw-kos -N ""
cat ~/.ssh/openclaw-kos.pub
# → Add to https://github.com/<you>/kevin-os/settings/keys with "Allow write"

# SSH config
cat >> ~/.ssh/config <<EOF
Host github-kos
  HostName github.com
  User git
  IdentityFile ~/.ssh/openclaw-kos
EOF

# Clone using:
git clone git@github-kos:<you>/kevin-os.git ~/kevin-os
```

Rotate annually. Revoke immediately if OpenClaw EC2 is ever compromised.

---

## 2. AWS access

**Purpose:** Read CloudWatch logs (debug Lambda errors), invoke Lambdas, read Secrets Manager (to pull DB/Notion/Google/etc. credentials directly instead of duplicating them), deploy dev stacks later.

**Approach:** Create a new dedicated IAM user `kos-openclaw-operator` with a scoped policy. Do NOT reuse Kevin's personal IAM user or root keys.

### Create the IAM user

```bash
# Run from your laptop (or this EC2) against the KOS account (239541130189):
aws iam create-user --user-name kos-openclaw-operator

aws iam put-user-policy --user-name kos-openclaw-operator \
  --policy-name kos-openclaw-scoped --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadLogs",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:eu-north-1:239541130189:secret:kos/*",
        "arn:aws:secretsmanager:eu-north-1:239541130189:secret:KosDataRdsInstanceSecret430-*"
      ]
    },
    {
      "Sid": "InvokeBedrockForAgents",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*",
        "arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-haiku-4-5*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*"
      ]
    },
    {
      "Sid": "InvokeExistingLambdasForShadowParity",
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:eu-north-1:239541130189:function:Kos*"
    },
    {
      "Sid": "ReadEventBridgeEventsForDebug",
      "Effect": "Allow",
      "Action": ["events:DescribeEventBus", "events:ListRules"],
      "Resource": "*"
    },
    {
      "Sid": "DenyDestructive",
      "Effect": "Deny",
      "Action": [
        "iam:*",
        "rds:Delete*",
        "rds:Modify*",
        "s3:Delete*",
        "lambda:DeleteFunction",
        "secretsmanager:Delete*",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "*"
    }
  ]
}'

aws iam create-access-key --user-name kos-openclaw-operator
# Save AccessKeyId + SecretAccessKey output IMMEDIATELY — it's only shown once.
```

### Install on OpenClaw EC2

```bash
ssh openclaw-ec2
mkdir -p ~/.aws
cat > ~/.aws/credentials <<EOF
[kos-openclaw]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
EOF
chmod 600 ~/.aws/credentials

cat > ~/.aws/config <<EOF
[profile kos-openclaw]
region = eu-north-1
output = json
EOF

# Sanity check:
AWS_PROFILE=kos-openclaw aws sts get-caller-identity
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text
```

### Promote later (when ready for Stage 3)

Add a second scoped policy `kos-openclaw-deploy-dev` that lets it `cdk deploy` to stacks named `Kos*Dev` only. Never grant prod deploy until after 4+ weeks of clean operation.

Rotate the access key every 90 days. Set a calendar reminder.

---

## 3. Postgres (RDS)

**Purpose:** OpenClaw reads entity_index, mention_events, email_drafts. Writes to proposals table for every AI-generated artifact. Writes to audit tables.

**Approach:** start with existing `dashboard_api` role (SELECT only). Promote to `kos_agent_writer` (INSERT/UPDATE) once OpenClaw proves safe.

### Read-only first (SHADOW MODE)

```bash
# Fetch existing dashboard_api credentials:
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/db/dashboard_api \
  --query SecretString --output text | jq .
```

That returns:
```json
{
  "host": "kosdatardsproxy4518f30a.proxy-cts46s6u6r3l.eu-north-1.rds.amazonaws.com",
  "port": 5432,
  "dbname": "kos",
  "username": "dashboard_api",
  "password": "<IAM-generated-token-OR-password>"
}
```

**Important:** the `dashboard_api` role uses **IAM auth** via RDS Proxy — the "password" in Secrets Manager is a placeholder. Real auth flow:

```bash
# OpenClaw agent generates fresh token per DB connection:
TOKEN=$(AWS_PROFILE=kos-openclaw aws rds generate-db-auth-token \
  --hostname kosdatardsproxy4518f30a.proxy-cts46s6u6r3l.eu-north-1.rds.amazonaws.com \
  --port 5432 \
  --region eu-north-1 \
  --username dashboard_api)

psql "host=kosdatardsproxy4518f30a.proxy-cts46s6u6r3l.eu-north-1.rds.amazonaws.com \
      port=5432 dbname=kos user=dashboard_api sslmode=require password=$TOKEN"
```

Tokens expire in 15 min. Any Postgres MCP server used here MUST refresh tokens per-connection, not cache them.

### Network — the hard part

KOS's RDS lives inside VPC `vpc-02675f6ccc181f6b3` with no public endpoint. OpenClaw's EC2 is in a separate VPC.

**Three connectivity options:**

**A. VPC peering** (cleanest, one-time setup): peer OpenClaw's VPC to KOS's VPC, add route table entries, add ingress rule to RDS SG `sg-0aaf935eabd3ee0d7` on port 5432 from OpenClaw's VPC CIDR. ~$0/mo, low latency.

**B. Bastion SSM tunnel** (cheapest, operationally annoying): deploy a t4g.nano bastion in KOS VPC (CDK `KosData --context bastion=true`), OpenClaw EC2 maintains `aws ssm start-session --document-name AWS-StartPortForwardingSessionToRemoteHost` tunneling RDS proxy to localhost:55432. Session times out at 20 min idle — needs a supervisor process to reconnect. ~$3/mo.

**C. Make RDS publicly accessible** (do not do this without VPN/IP allowlist + encrypted connections, explicit SG lock-down).

**Recommendation:** start with **B** while OpenClaw is in shadow mode (read-only, low volume). Move to **A** before promoting to write mode.

### Postgres MCP config

```bash
openclaw mcp set kos-postgres '{
  "command": "uvx",
  "args": ["postgres-mcp"],
  "env": {
    "POSTGRES_URL": "postgresql://dashboard_api@127.0.0.1:55432/kos?sslmode=require",
    "POSTGRES_IAM_AUTH": "true",
    "POSTGRES_IAM_REGION": "eu-north-1",
    "AWS_PROFILE": "kos-openclaw"
  }
}'
```

### When promoting (Stage 2+)

Swap username to `kos_agent_writer`. Same IAM-auth pattern. Also register a second MCP `kos-postgres-admin` using the master secret for the rare migration path — guarded by hard gates.

---

## 4. Notion

**Purpose:** read Command Center, Today page, Transkripten DB, Kevin Context page. Write action items + brief content. This is the backbone of KOS's Notion integration.

### Reuse existing

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/notion-token --query SecretString --output text
# → ntn_... (internal integration token, already has read+write on all KOS surfaces)
```

### Install on OpenClaw

```bash
echo "ntn_..." > ~/.openclaw/secrets/notion.token
chmod 600 ~/.openclaw/secrets/notion.token

openclaw mcp set notion '{
  "url": "https://mcp.notion.com",
  "transport": "streamable-http",
  "headers": {
    "Authorization": "Bearer $(cat ~/.openclaw/secrets/notion.token)"
  }
}'
```

### Notion IDs OpenClaw needs to know

These are in HANDOFF-OPENCLAW.md but listing here for credential-completeness:

```yaml
entities_db:        34afea43-6634-81b0-ad74-f472fd39a2d0
projects_db:        34afea43-6634-8146-98dc-c9acf100307f
command_center_db:  f4c693b1-68da-4be6-9828-ca55dc2712ee
today_page:         34dfea43-6634-8169-b2cc-cc804a8e6af3
kevin_context_page: 34afea43-6634-81aa-8a70-d3a2fca2beac
transkripten_ds:    97ac71f5-867e-493b-935c-57f1f8dc3a3a
```

---

## 5. Google (Gmail + Calendar)

**Purpose:** read incoming Gmail for both accounts, send drafts from Gmail once approved, read calendar events for both accounts.

**Two accounts, two OAuth bundles, already exist in KOS.**

### Fetch existing OAuth secrets

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/gcal-oauth-kevin-elzarka --query SecretString --output text | jq .
# → { client_id, client_secret, refresh_token, scopes: [gmail.modify, gmail.send, calendar.readonly] }

AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/gcal-oauth-kevin-taleforge --query SecretString --output text | jq .

AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/gmail-oauth-tokens --query SecretString --output text | jq .
# → General Gmail OAuth (used by gmail-poller)
```

### OAuth scopes currently granted
- `gmail.modify` — read + manage labels (NOT full `gmail` scope)
- `gmail.send` — send as Kevin
- `calendar.readonly` — read calendars (NOT `calendar` write)

If OpenClaw needs to create calendar events, you'd need to re-consent with `calendar` scope. For now, read-only calendar is what KOS actually uses.

### Install on OpenClaw

```bash
mkdir -p ~/.openclaw/secrets/google
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/gcal-oauth-kevin-elzarka --query SecretString --output text \
  > ~/.openclaw/secrets/google/elzarka.json
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/gcal-oauth-kevin-taleforge --query SecretString --output text \
  > ~/.openclaw/secrets/google/taleforge.json
chmod 600 ~/.openclaw/secrets/google/*.json

# Register each Gmail/Calendar account as a separate MCP:
openclaw mcp set gmail-elzarka '{
  "command": "uvx",
  "args": ["gmail-mcp-server"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/openclaw/.openclaw/secrets/google/elzarka.json" }
}'

openclaw mcp set gmail-taleforge '{
  "command": "uvx",
  "args": ["gmail-mcp-server"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/openclaw/.openclaw/secrets/google/taleforge.json" }
}'

openclaw mcp set gcal-elzarka '{
  "command": "uvx",
  "args": ["google-calendar-mcp"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/openclaw/.openclaw/secrets/google/elzarka.json" }
}'

openclaw mcp set gcal-taleforge '{
  "command": "uvx",
  "args": ["google-calendar-mcp"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/openclaw/.openclaw/secrets/google/taleforge.json" }
}'
```

### Refresh token handling

Refresh tokens rotate on some Google API calls. The MCP server should write the rotated token back to the JSON file. If it doesn't, add a 90-day calendar reminder to re-consent via `scripts/refresh-gcal-oauth.sh` (already in the repo).

---

## 6. Telegram bot

**Purpose:** OpenClaw receives messages from Kevin (currently `@zinkevbot`), responds, handles `/ask` + `/chat` commands.

### Reuse existing bot

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/telegram-bot-token --query SecretString --output text
# → <bot_id>:<token> format
```

### CRITICAL: webhook conflict

Telegram allows ONE webhook per bot. Currently, `@zinkevbot`'s webhook points to the KosCapture Lambda. When OpenClaw takes over, the webhook must switch to OpenClaw's Telegram channel listener.

**Two transition strategies:**

**A. Long polling (safest during shadow):** OpenClaw uses `getUpdates` polling instead of webhook. Doesn't conflict with existing webhook. Slight delay (5s) but fine for shadow testing. Set in OpenClaw config:
```json
{
  "channels": {
    "telegram": {
      "token": "<bot_token>",
      "mode": "polling",
      "allowFrom": ["<kevin-phone-intl>"]
    }
  }
}
```

**B. Webhook swap (Stage 2):** point the bot's webhook at OpenClaw's public URL. Simultaneously disable the KosCapture Lambda. This breaks the existing KOS Telegram path, so only do it when OpenClaw is proven.

### Install

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/telegram-bot-token --query SecretString --output text \
  > ~/.openclaw/secrets/telegram.token
chmod 600 ~/.openclaw/secrets/telegram.token

# Start in polling mode:
openclaw channels set telegram '{
  "tokenFile": "/home/openclaw/.openclaw/secrets/telegram.token",
  "mode": "polling",
  "allowFrom": ["YOUR_PHONE_E164"]
}'
```

### Kevin's allow-from

Replace `YOUR_PHONE_E164` with your phone number in E.164 format (e.g. `+46701234567`). Only messages from this number are processed. All other incoming messages get auto-rejected.

---

## 7. Bedrock (LLM inference)

**Purpose:** OpenClaw agents call Sonnet 4.6 for briefs + chat, Haiku 4.5 for triage. Already provisioned in KOS's AWS account.

### Access via IAM

The `kos-openclaw-operator` user (§2) already has `bedrock:InvokeModel` on the needed inference profiles. No extra credential.

### OpenClaw model provider config

```json
{
  "providers": {
    "bedrock": {
      "awsProfile": "kos-openclaw",
      "region": "eu-north-1",
      "models": {
        "default": "eu.anthropic.claude-sonnet-4-6",
        "fast": "eu.anthropic.claude-haiku-4-5"
      }
    }
  }
}
```

### Quotas to know

Current account Bedrock quotas:
- Sonnet 4.6: 50 req/min, 200k tokens/min
- Haiku 4.5: 100 req/min, 500k tokens/min

OpenClaw's per-agent retries + tool loops can hit the per-minute limit if misconfigured. Watch for `ThrottlingException` in logs; tune `retryPolicy` if you see them.

### Alternative: Anthropic API (not recommended)

If OpenClaw has trouble with Bedrock (it happens), you can fall back to direct Anthropic:

```bash
# Create at https://console.anthropic.com/settings/keys
echo "sk-ant-..." > ~/.openclaw/secrets/anthropic.key
chmod 600 ~/.openclaw/secrets/anthropic.key
```

Only do this as a fallback — Anthropic direct doesn't give you Kevin's account's existing spend caps and has no observability into the KOS cost model.

---

## 8. Sentry (observability)

**Purpose:** capture errors from OpenClaw agent runs alongside KOS's existing Sentry traces.

### Existing DSN

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/sentry-dsn --query SecretString --output text
# → https://<public_key>@<org>.ingest.sentry.io/<project_id>
```

### Install

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/sentry-dsn --query SecretString --output text \
  > ~/.openclaw/secrets/sentry.dsn
chmod 600 ~/.openclaw/secrets/sentry.dsn

# Register in OpenClaw config:
openclaw config set observability.sentry.dsnFile /home/openclaw/.openclaw/secrets/sentry.dsn
```

Add a tag `source=openclaw` to distinguish OpenClaw errors from KOS Lambda errors in the same project.

---

## 9. Langfuse (LLM tracing)

**Purpose:** trace every LLM call from OpenClaw agents. Pairs with KOS's existing Langfuse project so Kevin sees both in one dashboard.

### Existing keys

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/langfuse-public-key --query SecretString --output text
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/langfuse-secret-key --query SecretString --output text
```

### Install

```bash
openclaw config set observability.langfuse '{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com"
}'
```

---

## 10. Azure Search (semantic memory — optional)

**Purpose:** semantic retrieval over transcripts + entities. Used by `loadContext()` in agents. OpenClaw can use it OR its own builtin memory backend.

### Existing credentials

```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/azure-search-admin --query SecretString --output text | jq .
# → { endpoint, adminKey, indexName: "kos-memory-v2" }
```

### Decision point

**If OpenClaw uses Azure Search:** connect via an MCP plugin (custom — one doesn't exist off-the-shelf; would need ~2h to build against the Azure Search REST API). Reuses the 76 docs already indexed.

**If OpenClaw uses its builtin memory:** skip this credential entirely. OpenClaw's SQLite + embedding backend stores agent-observed context. You'd lose the existing 76 indexed docs unless you migrate them.

**Recommendation:** start with OpenClaw's builtin memory. Ignore Azure Search for first month. Revisit if OpenClaw's recall quality is insufficient — usually it isn't.

---

## 11. Other capture channels (for reference — not needed first week)

These are lower-priority. OpenClaw can ignore them during shadow + Stage 1. Reconnect during Stage 4 when migrating pollers.

### Granola API
```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/granola-api-key --query SecretString --output text
```
Used by granola-poller Lambda currently. Would only be needed if OpenClaw replaces that poller with a direct Granola API fetch instead of reading from Notion Transkripten DB.

### Chrome extension
```bash
# HMAC secret that signs POST requests from the Chrome extension:
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/chrome-extension-hmac-secret --query SecretString --output text
# Bearer token the extension sends:
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/chrome-extension-bearer --query SecretString --output text
```
Only needed if OpenClaw exposes a public HTTPS endpoint to receive Chrome ext captures. Can skip until Stage 4.

### iOS Shortcut webhook
```bash
AWS_PROFILE=kos-openclaw aws secretsmanager get-secret-value \
  --secret-id kos/ios-shortcut-webhook-secret --query SecretString --output text
```
Same — Stage 4.

### EmailEngine (deferred in KOS)
EmailEngine isn't currently running in prod — gmail-poller replaced it. Skip entirely unless you decide to revive EmailEngine for IMAP push.

---

## 12. One-shot setup script

Here's the entire §1-§9 setup as a script. Run on OpenClaw EC2 after AWS profile is configured:

```bash
#!/bin/bash
set -euo pipefail

echo "=== Fetching KOS credentials from Secrets Manager ==="
mkdir -p ~/.openclaw/secrets/google
cd ~/.openclaw/secrets

aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/notion-token --query SecretString --output text > notion.token
aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/telegram-bot-token --query SecretString --output text > telegram.token
aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/sentry-dsn --query SecretString --output text > sentry.dsn
aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/gcal-oauth-kevin-elzarka --query SecretString --output text > google/elzarka.json
aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/gcal-oauth-kevin-taleforge --query SecretString --output text > google/taleforge.json

LANGFUSE_PK=$(aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/langfuse-public-key --query SecretString --output text)
LANGFUSE_SK=$(aws secretsmanager get-secret-value --profile kos-openclaw \
  --secret-id kos/langfuse-secret-key --query SecretString --output text)

chmod 600 ~/.openclaw/secrets/*.token ~/.openclaw/secrets/*.dsn ~/.openclaw/secrets/google/*.json

echo "=== Registering MCP servers ==="

openclaw mcp set notion "{
  \"url\": \"https://mcp.notion.com\",
  \"transport\": \"streamable-http\",
  \"headers\": {
    \"Authorization\": \"Bearer $(cat ~/.openclaw/secrets/notion.token)\"
  }
}"

openclaw mcp set gmail-elzarka '{
  "command": "uvx", "args": ["gmail-mcp-server"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/'"$USER"'/.openclaw/secrets/google/elzarka.json" }
}'

openclaw mcp set gmail-taleforge '{
  "command": "uvx", "args": ["gmail-mcp-server"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/'"$USER"'/.openclaw/secrets/google/taleforge.json" }
}'

openclaw mcp set gcal-elzarka '{
  "command": "uvx", "args": ["google-calendar-mcp"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/'"$USER"'/.openclaw/secrets/google/elzarka.json" }
}'

openclaw mcp set gcal-taleforge '{
  "command": "uvx", "args": ["google-calendar-mcp"],
  "env": { "GOOGLE_OAUTH_JSON": "/home/'"$USER"'/.openclaw/secrets/google/taleforge.json" }
}'

# CloudWatch via awslabs
openclaw mcp set cloudwatch '{
  "command": "uvx",
  "args": ["--from", "awslabs.cloudwatch-mcp-server", "awslabs.cloudwatch-mcp-server"],
  "env": { "AWS_PROFILE": "kos-openclaw", "AWS_REGION": "eu-north-1" }
}'

# Postgres (requires SSM tunnel or VPC peering — configure separately)
# See §3 for the tunnel setup. MCP config:
openclaw mcp set kos-postgres '{
  "command": "uvx", "args": ["postgres-mcp"],
  "env": {
    "POSTGRES_URL": "postgresql://dashboard_api@127.0.0.1:55432/kos?sslmode=require",
    "POSTGRES_IAM_AUTH": "true",
    "POSTGRES_IAM_REGION": "eu-north-1",
    "AWS_PROFILE": "kos-openclaw"
  }
}'

echo "=== Configuring providers ==="

openclaw config set providers.bedrock '{
  "awsProfile": "kos-openclaw",
  "region": "eu-north-1",
  "models": {
    "default": "eu.anthropic.claude-sonnet-4-6",
    "fast": "eu.anthropic.claude-haiku-4-5"
  }
}'

openclaw config set observability.sentry.dsnFile ~/.openclaw/secrets/sentry.dsn
openclaw config set observability.langfuse "{
  \"publicKey\": \"$LANGFUSE_PK\",
  \"secretKey\": \"$LANGFUSE_SK\",
  \"baseUrl\": \"https://cloud.langfuse.com\"
}"

echo "=== Configuring Telegram (polling mode — safe to run alongside existing KOS Telegram) ==="
openclaw channels set telegram "{
  \"tokenFile\": \"/home/$USER/.openclaw/secrets/telegram.token\",
  \"mode\": \"polling\",
  \"allowFrom\": [\"+46XXXXXXXXX\"]
}"

echo "=== Loading agent context ==="
mkdir -p ~/.openclaw/workspace
cd ~/kevin-os && git pull
cp ~/kevin-os/.claude/agents/SOUL.md ~/.openclaw/workspace/SOUL.md
cp ~/kevin-os/.claude/agents/BOOT.md ~/.openclaw/workspace/BOOT.md
cp ~/kevin-os/.planning/HANDOFF-OPENCLAW.md ~/.openclaw/workspace/HANDOFF.md
cp ~/kevin-os/AGENTS.md ~/.openclaw/workspace/PROJECT.md
echo "shadow" > ~/.openclaw/workspace/MODE

echo "=== Done. Kick off with: openclaw gateway --force ==="
echo "Then message @zinkevbot from Telegram to talk to KOS Operator."
```

Save as `~/.openclaw/setup-kos.sh`, `chmod +x`, run once.

---

## 13. Security hardening (do these during first week)

1. **VPS firewall** — only SSH from your IP. No public HTTP until you explicitly enable webhook mode for Telegram.
2. **AWS creds scope** — audit the `kos-openclaw-operator` policy monthly. Remove permissions it hasn't used.
3. **Secrets file permissions** — `~/.openclaw/secrets/*` must be `chmod 600`. Root-owned filesystem if possible.
4. **Audit logging** — every `openclaw exec`, every `git push`, every `cdk deploy` should write to `~/.openclaw/audit.log` with timestamp + action + result. Configure in `openclaw config set audit.enabled true`.
5. **Backup** — `~/.openclaw/workspace/MEMORY.md` is OpenClaw's brain. Rsync it to S3 daily so you can recover if the VPS dies.
6. **Emergency stop** — document how to kill OpenClaw from Kevin's phone without SSH:
   ```
   Telegram → @zinkevbot → "STOP"
   Or: AWS Console → EC2 → OpenClaw instance → Stop instance
   ```

---

## 14. Promotion ladder

Move up one rung per week. Never skip rungs.

1. **Week 1 — Shadow:** reads all MCPs, writes nothing. Kevin talks to it via Telegram, it answers from real data.
2. **Week 2 — Dev write:** can commit to `openclaw-dev` branch, open PRs to `main`. Kevin still merges.
3. **Week 3 — Dev deploy:** can `cdk deploy Kos*Dev` and `vercel deploy` (preview).
4. **Week 4 — Prod gated:** can run backfills, insert into proposals, edit Command Center — but NOT prod CDK deploy, NOT email send, NOT Notion bulk-archive.
5. **Month 2+ — Prod operational:** full soft-gate autonomy, hard gates still require Kevin's yes+code.

---

## Related

- `.planning/HANDOFF-OPENCLAW.md` — what KOS IS + data model
- `.claude/agents/SOUL.md` — personality + guardrails
- `.claude/agents/BOOT.md` — first-contact protocol
- `.kilo/skills/kos-aws-ops/SKILL.md` — AWS operational knowledge
- `.kilo/skills/kos-rds-ops/SKILL.md` — RDS specifics
- `.kilo/skills/kos-notion-gotchas/SKILL.md` — Notion conventions
