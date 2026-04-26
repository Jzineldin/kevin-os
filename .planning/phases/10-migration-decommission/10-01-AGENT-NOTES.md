---
phase: 10-migration-decommission
plan: 10-01
agent: claude-opus-4-7
worktree: agent-a46111793a350a546
date: 2026-04-26
---

# Plan 10-01 — Agent Notes (MIG-01 classify_and_save adapter)

Plan 10-01 (Wave 1) implementation. Drops the actual handler body into the
Wave-0 scaffold from Plan 10-00, ships the same-substance verifier script,
and writes the T-0 cutover runbook.

## What was implemented

### Task 1 — Lambda handler + HMAC + emit + tests

| File | Purpose | Lines |
|------|---------|-------|
| `services/vps-classify-migration/src/handler.ts` | Full handler body (HMAC + Bearer + Zod + EB emit + Sentry) | 238 |
| `services/vps-classify-migration/src/hmac.ts` | `verifySignature` + `validateHmac` + `constantTimeEquals` | 130 |
| `services/vps-classify-migration/src/emit.ts` | `emitCaptureReceived` (PutEvents on `kos.capture`) | 102 |
| `services/vps-classify-migration/src/secrets.ts` | Cached Secrets Manager loader (fail-closed on PLACEHOLDER) | 60 |
| `services/vps-classify-migration/test/handler.test.ts` | 17 cases | 388 |
| `services/vps-classify-migration/test/hmac.test.ts` | 15 cases | 134 |

**Test totals:** 32 cases passing (15 hmac + 17 handler).

The plan asked for 8 mandatory behaviours; all 8 are encoded as named
`Test 1..8` cases in `handler.test.ts`. Belt-and-braces tests were added
on top: missing Bearer, missing X-KOS-Signature, non-POST, empty body,
PLACEHOLDER secret, Sentry init invocation, FailedEntryCount > 0 = 500.

### Task 2 — Same-substance verifier (Gemini 2.5 Pro judge)

| File | Purpose | Lines |
|------|---------|-------|
| `scripts/verify-classify-substance.mjs` | ESM Node script — Notion sample → Lambda re-run → Gemini judge → markdown report | 482 |
| `scripts/.fixtures/verify-classify-substance-prompt.txt` | Verbatim prompt template the script `.replace`s into | 15 |

Script supports `--script {classify|morning|evening}`, `--since YYYY-MM-DD`
(default 7 days ago), `--sample-size N` (default 10), and `--dry-run`. Exit
codes per plan spec: `0` (clean), `1` (any pair < 0.5), `2` (sample corpus
< 10 rows). Read-only / Lambda:Invoke only — never writes Notion or RDS.

The plan's verify automation grep checks all pass:
- `@google-cloud/vertexai`
- `operator_review_checklist`
- `gemini-2.5-pro`
- `--dry-run`
- `scripts/.fixtures/verify-classify-substance-prompt.txt` exists
- `node --check scripts/verify-classify-substance.mjs` clean

### Task 3 — Cutover runbook

| File | Purpose |
|------|---------|
| `.planning/phases/10-migration-decommission/10-01-CUTOVER-RUNBOOK.md` | T-0 atomic flip + T+30min rollback procedure |

The runbook covers Pre-cutover (T-24h to T-0) → T-0 (< 30 sec) → T+5min
verification → Rollback (T+30min) → Day 7 gate. `# DRY_RUN_EVIDENCE:`
placeholder is reserved for the operator's pre-cutover transcript.

Plan's verify automation passes:
- file exists
- contains `T-0`
- contains `rollback`
- contains `DRY_RUN_EVIDENCE`

## Architectural decisions taken inside the plan

### D-10-01-A: EventBridge `Source` distinct from `kos.capture`

The plan's interface comment mentions `channel: 'vps-classify-migration'`
on the `capture.received` event. But the canonical
`CaptureReceivedTextSchema` (Phase 2) constrains `channel` to
`'telegram' | 'dashboard'`. Adding a 3rd literal would be a contracts-
package change with downstream test churn and would also break the rule
"adapter is a passthrough" — the body shape from VPS-side `classify_and_save.py`
is open (arbitrary keyword args).

**Decision:** keep the `kos.capture` bus, but emit with
`Source: 'kos.capture-migration-adapter'` (distinct from Phase 2's `Source:
'kos.capture'`). The `Detail` body is custom — not a `CaptureReceivedTextSchema`
shape — and carries `{ capture_id, source, emitted_at, raw }` where `raw`
is the pass-through Zod-parsed payload. The `source` literal IS
`'vps-classify-migration-adapter'`, matching the existing
`ClassifyAdapterResultSchema` that Plan 10-00 baked into `@kos/contracts`.

This means triage's existing rule (Source = `'kos.capture'`) does NOT pick
up adapter traffic during the migration overlap. That's intentional and
matches D-08 (the adapter publishes to the bus for audit, not to drive
agents). The Phase 10-07 Gate review can decide to wire a consumer in if
needed.

### D-10-01-B: Bearer = HMAC secret (single shared secret today)

The plan's threat model (T-10-01-01) treats Bearer + HMAC as defence-in-depth
"two-secret" pair. In practice the Wave-0 scaffold's MigrationStack
provisions ONE secret (`kos/vps-classify-hmac-secret`). Splitting it into
two would require a second `aws_secretsmanager:Secret` + grantRead — out of
scope for Wave 1.

**Decision:** Bearer header value = HMAC secret value. Both compared with
`crypto.timingSafeEqual`. The auth surface is uniform with
`services/chrome-webhook` (the reference Plan 10-00 cites). Future plans
can split if a defence-in-depth rotation is required.

### D-10-01-C: 202 vs 200

Plan task action says "Return 202 { capture_id, adapter_version: '10-01-v1' }".
Plan's behaviour Tests 5/6 say "old-shape payload maps to capture.received".

**Decision:** 202 it is. The response body is the full
`ClassifyAdapterResultSchema` (capture_id, emitted_at, source) PLUS a
`adapter_version: '10-01-v1'` field. The 202 status code is semantically
correct — we've accepted the payload but processing is async on our side
(triage / voice-capture / etc. consume from EventBridge).

### D-10-01-D: ts is parsed from `t=...` header per ios-webhook convention

The plan task action specifies `event.headers['x-timestamp']` as the
timestamp source. The ios-webhook convention (Phase 4) packs both `t=` and
`v1=` into a single `X-KOS-Signature` header (`t=<unix>,v1=<hex>`).

**Decision:** follow the ios-webhook convention since Plan 10-00's scaffold
docstring explicitly cites `services/chrome-webhook` (which also packs
both into one header). The handler does NOT read a separate `x-timestamp`
header. The `validateHmac` loose-args helper IS exposed for tests that
want to assert the timestamp + signature components in isolation, but the
on-the-wire shape is the single combined header.

### D-10-01-E: Lambda Function URL caps body at 1MB defence-in-depth

Function URL itself caps at 6 MB. The handler enforces a tighter 1 MB
ceiling because real classify_and_save payloads are short (the legacy
script writes them into a 1900-char Notion rich_text field).

## Operator-deferred items

These are NOT done by this plan execution — they live in the cutover
runbook and require operator action during the actual T-0:

1. **Seed `kos/vps-classify-hmac-secret`** — CDK creates it as PLACEHOLDER;
   `openssl rand -hex 32` + `aws secretsmanager put-secret-value`.
2. **Paste the HMAC secret into the VPS-side caller** — SSH 98.91.6.66,
   edit `/etc/kos-freeze.env`, restart `classify_and_save.service`.
3. **Flip the upstream caller's webhook URL** — n8n / cron / SaaS, depending
   on what fires the legacy webhook.
4. **Stop the VPS classify unit** — `systemctl stop`. Phase 1's freeze
   redirect remains as the rollback floor.
5. **Run the 7-day verifier** — `node scripts/verify-classify-substance.mjs
   --script classify` daily. Kevin signs off on 10/10 PASS for SC 1 closure.
6. **Vertex AI SA key** — `.gcp-sa-key.json` must be locally available
   (Phase 6 deferred-item). Without it, `--dry-run` mode is the operator's
   fallback for spot-checks.
7. **10 cutover dry-run transcripts** — pasted into `# DRY_RUN_EVIDENCE:`
   placeholder of the runbook before the real T-0.

## Verification record

```bash
$ pnpm --filter @kos/service-vps-classify-migration test -- --run
 ✓ test/hmac.test.ts  (15 tests) 18ms
 ✓ test/handler.test.ts  (17 tests) 1015ms
 Test Files  2 passed (2)
      Tests  32 passed (32)

$ pnpm --filter @kos/service-vps-classify-migration typecheck
$ tsc --noEmit
(clean)

$ node --check scripts/verify-classify-substance.mjs
(clean)

$ pnpm --filter @kos/cdk vitest run test/integrations-migration.test.ts
 ✓ test/integrations-migration.test.ts  (9 tests) 127398ms
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ pnpm --filter @kos/contracts test
 Test Files  5 passed (5)
      Tests  59 passed (59)
```

## Files modified vs files created

### Modified (Wave-0 → Wave-1):
- `services/vps-classify-migration/src/handler.ts` — scaffold throw → full body
- `services/vps-classify-migration/test/handler.test.ts` — 1 test + 1 todo → 17 tests
- `services/vps-classify-migration/package.json` — added `@sentry/aws-serverless` + `aws-sdk-client-mock`
- `services/vps-classify-migration/tsconfig.json` — added `@sentry/*` path + `_shared/sentry.ts` include

### Created (new):
- `services/vps-classify-migration/src/hmac.ts`
- `services/vps-classify-migration/src/emit.ts`
- `services/vps-classify-migration/src/secrets.ts`
- `services/vps-classify-migration/test/hmac.test.ts`
- `scripts/verify-classify-substance.mjs`
- `scripts/.fixtures/verify-classify-substance-prompt.txt`
- `.planning/phases/10-migration-decommission/10-01-CUTOVER-RUNBOOK.md`
- `.planning/phases/10-migration-decommission/10-01-AGENT-NOTES.md` (this file)

## Outstanding for Plan 10-07 / Gate review

- Wire a consumer for the `Source: 'kos.capture-migration-adapter'` events
  if the dashboard wants to surface them. Right now they sit on the bus
  un-consumed (audit-only). Acceptable per D-08; revisit at Gate 10.
- Plan 10-02 retires `morning_briefing` + `evening_checkin` via Phase 7
  AUTO-01/AUTO-03 — uses the same `--script morning|evening` modes of the
  verifier we shipped here.
- The same-substance gate Day-7 sign-off is a manual operator step. Until
  Kevin signs the report's checklist, SC 1 stays open.
