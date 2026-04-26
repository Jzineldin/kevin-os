# CAP-10 Discord Brain-Dump Contract

**Phase 5 Plan 05-06** (this contract) owns the EventBridge Scheduler.
**Phase 10 Plan 10-04** owns the `discord-brain-dump-listener` Lambda handler.

This document is the load-bearing interface between the two phases. Phase 5
ships the Scheduler against an SSM-resolved Lambda ARN; Phase 10 ships the
Lambda and seeds the SSM parameter. Either deploy order is safe.

---

## Scheduler → Lambda Input

The EventBridge Scheduler (`kos-discord-poll`) fires every 5 min UTC and
invokes the Phase 10 Lambda with this static payload:

```json
{
  "channel": "brain-dump",
  "owner_id": "<KEVIN_OWNER_ID UUID>",
  "trigger_source": "kos-discord-poll-scheduler"
}
```

| Field            | Type   | Notes                                                            |
|------------------|--------|------------------------------------------------------------------|
| `channel`        | string | Always `'brain-dump'` — discriminator if more channels are added. |
| `owner_id`       | uuid   | KEVIN_OWNER_ID baked in at synth time by `wireDiscordSchedule`.  |
| `trigger_source` | string | Always `'kos-discord-poll-scheduler'` — distinguishes from manual invokes. |

The Lambda MUST validate `channel === 'brain-dump'` and reject otherwise.
The cursor is NOT carried in the payload — see [Cursor](#cursor) below.

---

## Lambda → kos.capture Output

Per new Discord message the Phase 10 Lambda emits exactly one
`capture.received` event onto the `kos.capture` EventBus, conforming to
`@kos/contracts/CaptureReceivedDiscordTextSchema` (already shipped in
Plan 05-00):

```json
{
  "capture_id": "<26-char-Crockford-base32-ULID>",
  "channel": "discord",
  "kind": "discord_text",
  "channel_id": "<discord-channel-snowflake>",
  "message_id": "<discord-message-snowflake>",
  "author": {
    "id": "<author-snowflake>",
    "display": "<optional-display-name>"
  },
  "body": "<message text, 1..50_000 chars>",
  "sent_at": "<ISO-8601 datetime, from Discord message timestamp>",
  "received_at": "<ISO-8601 datetime, when the Lambda observed it>"
}
```

The Zod schema in `packages/contracts/src/events.ts` is the source of
truth — Phase 10 imports `CaptureReceivedDiscordTextSchema` and parses
its output before publishing.

---

## Idempotency

`capture_id` MUST be deterministic from `(channel_id, message_id)` so
that retries (Scheduler-level OR Lambda-level OR Discord transient
errors) never produce duplicate downstream side effects.

Recommended derivation (Phase 10 to confirm at implementation time):

```
sha256("discord:" + channel_id + ":" + message_id)
  → take first 16 bytes
  → Crockford base32 encode
  → produces 26-char ULID-shaped capture_id
```

Triage's existing `capture_id` dedupe at the kos.capture consumer layer
catches duplicates regardless of source — this is defense in depth.

---

## Cursor

Phase 10 Lambda maintains a per-channel cursor (`last_seen_message_id`)
in RDS. The exact table + column names are at Plan 10-04's discretion;
candidates include reusing `notion_indexer_cursor` with a `source`
discriminator, or adding a `discord_poller_cursor` table.

The Scheduler input does NOT carry the cursor — it is Lambda-local
state. The Discord query is `GET /channels/{channel_id}/messages?after={cursor}&limit=50`.

If the cursor is empty (cold start), the Lambda fetches the most-recent
message only, stores its ID as the cursor, and emits zero events — no
backfill. Backfill, if ever desired, is an operator-triggered runbook
not part of the steady-state contract.

---

## Rate-limit budget

Discord API limits (per bot/user token, as of 2026-04):

- Global: 50 requests/sec
- Per-channel read: 10 requests/sec

At 12 invocations/hour (every 5 min) × 1 GET per invocation = 0.0033 RPS.
Far below either ceiling. If Phase 10 ever paginates (e.g. >50 backlog
messages), it MAY make ~5 calls in a single invocation; still trivial.

---

## Graceful degradation (D-22)

The Phase 10 Lambda MUST handle these failure modes without paging Kevin:

| Failure                              | Detection                | Handling                                                                               |
|--------------------------------------|--------------------------|----------------------------------------------------------------------------------------|
| Bot/user token revoked or expired    | HTTP 401 from Discord    | Insert `system_alerts` row + update `sync_status` row for `channel='discord'`. Exit 200. |
| Channel archived / bot kicked        | HTTP 404 from Discord    | Same treatment as 401.                                                                 |
| Discord 5xx                          | Non-2xx, non-4xx         | Exponential backoff inside the invocation; if still failing, exit 200 (next 5-min retry). |
| Rate-limit (HTTP 429)                | `X-RateLimit-*` headers  | Honor `Retry-After`; if exceeds invocation timeout, exit 200 and let next tick resume. |

No Telegram fire-alarm on Discord failures. Dashboard surfaces via
`sync_status`. Daily morning brief mentions if the channel has been
unhealthy for >12h.

---

## Deploy order resilience

The Phase 5 Scheduler reads its target Lambda ARN from SSM parameter
`/kos/discord/brain-dump-lambda-arn` at synth/deploy time. There are
three safe orderings:

1. **Phase 10 lands first**: Phase 10 deploys Lambda → seeds SSM param
   with the real ARN → Phase 5 deploys Scheduler pinned to the real ARN.
   Schedule starts firing immediately.

2. **Phase 5 lands first** (current case): Operator pre-seeds SSM param
   with a no-op Lambda ARN (any Lambda that returns 200 for any event is
   fine; KOS already has `KosLifecycleHook` etc. that satisfy the
   shape). Phase 5 deploys Scheduler pinned to the no-op ARN. When
   Phase 10 lands, operator updates the SSM param + redeploys the
   Phase 5 Scheduler stack to pick the new ARN. (CDK Scheduler target is
   resolved at rule-creation time, NOT runtime — a CFN update is
   required to re-pin the target.)

3. **Both at once**: same as (1).

The contract is symmetric — neither phase blocks the other.

### Operator runbook for SSM seeding

```bash
# Pre-Phase-10 (deploy-unblock with a no-op):
aws ssm put-parameter \
  --name /kos/discord/brain-dump-lambda-arn \
  --type String \
  --value "arn:aws:lambda:eu-north-1:${ACCOUNT_ID}:function:KosLifecycleHook" \
  --overwrite

# Post-Phase-10 (real ARN):
aws ssm put-parameter \
  --name /kos/discord/brain-dump-lambda-arn \
  --type String \
  --value "arn:aws:lambda:eu-north-1:${ACCOUNT_ID}:function:DiscordBrainDumpListener" \
  --overwrite

# Then redeploy IntegrationsStack:
pnpm --filter @kos/cdk deploy IntegrationsStack
```

---

## Threat model boundary handoff

Phase 5 owns:
- Scheduler IAM role (trust policy: scheduler.amazonaws.com).
- `lambda:InvokeFunction` policy scoped to the SSM-resolved ARN.
- Schedule retry policy (2 retries, 5-min event-age cutoff).

Phase 10 owns:
- Lambda resource policy restricting InvokeFunction to the Phase-5 role.
- Discord token retrieval from Secrets Manager.
- `kos.capture` PutEvents permission.
- Cursor-table RDS Proxy IAM access.

T-05-06-01 (Spoofing — direct Lambda invoke) is mitigated at the Phase
10 boundary, NOT here.

---

## Open questions for Phase 10 (non-blocking)

- Bot account vs user token? — Likely user token if Discord lacks a bot
  on the brain-dump server. Phase 10 owns the secret name (recommend
  `kos/discord-bot-token` for forward compatibility regardless of which
  identity it actually holds).
- Multi-channel? — Plan 05-06 wires ONE schedule for `brain-dump`. If
  more channels join later, they get their own Scheduler entries with
  their own SSM-resolved ARNs (or one Lambda + multi-channel input
  payload — Phase 10 chooses).
