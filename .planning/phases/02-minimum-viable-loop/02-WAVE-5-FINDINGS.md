---
phase: 02-minimum-viable-loop
wave: 5
status: partial-evidence
date: 2026-04-22
---

# Wave 5 — Live E2E Findings

Wave 5 ran a synthetic Swedish voice memo through the deployed Phase 2
pipeline against live AWS, Notion, and Bedrock. **Eight architectural
gaps surfaced and were fixed in this PR.** The data path is now proven
end-to-end. Two gaps remain (entity-resolver Cohere model migration +
push-telegram IAM-auth flavor) and are deferred to Phase 02.1.

## What works end-to-end now

```
EventBridge (kos.capture) capture.voice.transcribed
  → triage Lambda (Bedrock Haiku 4.5 via @anthropic-ai/bedrock-sdk)  ✅
    → emits triage.routed to kos.triage
  → voice-capture Lambda (Bedrock Haiku 4.5)                          ✅
    → writes a real row to Kevin's Notion Command Center DB           ✅
    → emits entity.mention.detected to kos.agent
  → entity-resolver Lambda (reaches Cohere Embed → fails on model ID) ⚠
  → push-telegram Lambda (reaches RDS → IAM auth flavor mismatch)     ⚠
```

Sentry receives errors live. Langfuse keys load via Secrets Manager.

## Gaps fixed in this PR (8)

| # | Gap | Root cause | Fix |
|---|---|---|---|
| 1 | grammY Lambda crashes at INIT with `Dynamic require of "http"` | esbuild `--format=esm` + `--minify` strips CommonJS shim | Add `createRequire` banner in `KosLambda` esbuild config |
| 2 | All RDS-using Lambdas time out on `pg.Pool` | Lambdas had `VpcConfig: null` — no VPC placement | Add `vpc` + `vpcSubnets` + `securityGroups` to KosLambda calls in `agents-stack`, `integrations-notion`, `safety-stack` |
| 3 | Lambdas in private subnet can't reach Bedrock / Notion / Telegram | D-05 set `natGateways: 0`. PRIVATE_ISOLATED has no internet egress | Reverse D-05: add `natGateways: 1`. New `lambda` subnet type = PRIVATE_WITH_EGRESS. RDS + bastion remain in PRIVATE_ISOLATED |
| 4 | Lambdas blocked from HTTPS egress despite NAT | Shared `kos_admin` RDS SG had egress only for `tcp/5432→self` | Add `0.0.0.0/0 :allTraffic` egress to RDS SG (live hotfix; CDK update needed for proper Lambda SG separation) |
| 5 | Tracing module never loaded Langfuse keys in Lambda | `tracing.ts` read literal `LANGFUSE_PUBLIC_KEY` env var; CDK only set `*_SECRET_ARN` | New `setupOtelTracingAsync()` fetches from Secrets Manager. Sync `setupOtelTracing()` retained for tests |
| 6 | Postgres rejected `KEVIN_OWNER_ID="kevin"` | env var was deployed as literal string; DB column is UUID | Use deterministic UUID `uuid5(NS_DNS, 'kevin@tale-forge.app')` = `9e4be978-cc7d-571b-98ec-a1e92373682c`. Stable across redeploys |
| 7 | Claude Agent SDK can't run in Lambda | `@anthropic-ai/claude-agent-sdk`'s `query()` spawns `claude` CLI subprocess; binary stripped by `esbuild --omit=optional` | Replaced `query()` with `AnthropicBedrock` from `@anthropic-ai/bedrock-sdk` in 3 services (triage, voice-capture, entity-resolver disambig). Direct Bedrock call — pure structured output, no agent loops needed |
| 8 | Voice-capture wrote wrong Notion property names | Phase 2 hardcoded `Name`/`Type`/`Urgency`/`Capture ID` — Kevin's actual DB has `Uppgift`/`Typ`/`Prioritet`/`Anteckningar` (Swedish, emoji-prefixed select options) | Map Phase 2 internal vocab → Kevin's Swedish CC schema in `voice-capture/src/notion.ts` |

Sub-fixes:
- Bedrock model ID format: `eu.anthropic.claude-haiku-4-5` → `eu.anthropic.claude-haiku-4-5-20251001-v1:0`
- Empty Kevin Context block crashes Bedrock (`cache_control on empty text`); skip block when text is empty
- Voice-capture Notion DB ID lookup falls back to `NOTION_COMMAND_CENTER_DB_ID` env (CDK was injecting it but code only checked file)
- RDS Proxy CDK config pinned to `PRIVATE_ISOLATED` so adding lambda subnets doesn't trigger replacement

Worth noting: **Phase 1's notion-indexer was silently failing every 5-min poll for ~3 days** — same VPC + SG egress bug. Phase 1 was marked complete on `cdk synth` + unit tests only. Live invocation was never verified. Wave 5 caught it.

## Gaps remaining (deferred to Phase 02.1)

### Gap A: entity-resolver Cohere embed model migration (high)

`packages/resolver/src/embed.ts` calls Bedrock with model ID
`cohere.embed-multilingual-v3`. That model is **not available in
`eu-north-1` Bedrock**. Only `cohere.embed-v4:0` is.

Options:
1. Migrate to `cohere.embed-v4:0` — different API shape
   (`embedding_types`, `output_dimension`); existing 1024-dim choice
   stays compatible. Need to rewrite `embed.ts` to v4 schema. May affect
   recall slightly; re-tune the 0.75/0.95 thresholds.
2. Cross-region call from eu-north-1 Lambda → us-east-1 Bedrock. Adds
   ~100ms latency, more complex IAM, cross-region data transfer cost.

Recommended: option 1.

### Gap B: push-telegram RDS IAM auth flavor (medium)

push-telegram opens `pg.Pool` with the `rdsCredentialsSecret` password
path. RDS Proxy is configured with `iamAuth: true, requireTLS: true`
which **rejects password auth** even though the credentials are
correct.

The agent Lambdas use `@aws-sdk/rds-signer` to mint short-lived IAM
tokens for pg connections. push-telegram needs the same. It currently
has the `rds-db:connect` IAM policy (added in this PR) but the Pool
config still uses password auth.

Fix: replace push-telegram's connection setup with the same
`getPool()` pattern from `services/triage/src/persist.ts`.

Practical impact: push-telegram can't write the
`denied_messages` audit row when the cap blocks a send. The send
itself doesn't need RDS — the cap counter lives in DynamoDB. So
quiet-hours and cap enforcement still work; only the audit log breaks.

### Gap C: Phase 1 notion-indexer was failing silently (high — already in this PR)

This PR's VPC fix re-enables notion-indexer. Once deployed, the 5-min
schedule will start succeeding again. Recommend a follow-up to
investigate WHAT it's been failing to sync for the past few days
(Notion → entity_index drift).

### Gap D: Telegram webhook keeps getting auto-cleared (low — investigation needed)

Setting the webhook URL via `setWebhook` succeeds but Telegram clears
it again within ~30s. `getWebhookInfo.last_error` stays empty (so it's
not Telegram auto-disabling on errors). Most likely cause: another
process (dev script, leftover poller) is calling `getUpdates` or
`setWebhook ""`.

For Wave 5 we bypassed Telegram entirely — emitted
`capture.voice.transcribed` directly to EventBridge. The full chain
behind it works. Need to find the rogue caller.

## Live E2E run record

Last successful synthetic run:
- `capture_id`: `01KPVG1V9C795YG0YJVB2R8N6V` (and several others — see CloudWatch)
- triage Lambda: 1.7s, success
- voice-capture Lambda: 3.5s, success
- Notion Command Center row created (verified via Notion API)
- entity-resolver Lambda: failed at Cohere embed call (Gap A)
- push-telegram Lambda: failed at RDS IAM auth (Gap B)

## Architectural decisions revised in this PR

- **D-05 reversed**: `natGateways: 0` → `natGateways: 1`. Cost addition
  ~$32/mo + data transfer. The original decision was incompatible with
  the agent Lambdas' need for both RDS access and external API calls
  (Bedrock, Notion, Telegram, Sentry, Langfuse).

- **Claude Agent SDK abandoned for Lambda inference**. CLAUDE.md
  research picked the agent SDK based on a misread of what it does at
  runtime. The SDK is designed for interactive Claude Code usage and
  spawns a CLI subprocess. For Lambda LLM calls (structured output, no
  tools), use `@anthropic-ai/bedrock-sdk` directly.

- **Bastion subnet placement**: bastion stays in PRIVATE_ISOLATED.
  Its SSM connectivity uses the temporary VPC interface endpoints
  pattern from the live migration (those endpoints were removed; need
  to re-create or add NAT route for next operator session). Logged as
  a Phase 1.x backlog item.
