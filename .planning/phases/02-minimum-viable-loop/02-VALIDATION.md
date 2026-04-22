---
phase: 02
slug: minimum-viable-loop
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-22
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> See `02-RESEARCH.md` §"Validation Architecture" for the authoritative per-task verification matrix. Planner finalises Task IDs here.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (unit) + AWS CLI / Node CLI assertions (integration) |
| **Config file** | per-package `vitest.config.ts` under `services/*` and `packages/*` |
| **Quick run command** | `pnpm -w test -- --run` |
| **Full suite command** | `pnpm -w test -- --run && pnpm run verify:phase-2` |
| **Estimated runtime** | ~90–120 s quick / ~10 min full (unit + mocked integrations) |

---

## Sampling Rate

- **After every task commit:** `pnpm -w test -- --run` (affected packages via `pnpm --filter`)
- **After every plan wave:** `pnpm -w test -- --run && (cd packages/cdk && npx cdk synth KosCapture KosAgents)` — new stacks
- **Before `/gsd-verify-work`:** `pnpm run verify:phase-2` must be green
- **Max feedback latency:** ≤120 s (unit) / ≤10 min (integration)

---

## Per-Task Verification Map

Planner finalises rows as plans are authored. Every task has an `<automated>` verify OR a Wave 0 dependency that installs the missing framework.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-00-XX | 00 | 0 | CAP-01 scaffold | T-02-SCAFFOLD-01 | Per-service vitest + mock fixtures installed | unit | `pnpm -w test -- --run` | ❌ W0 | ⬜ pending |
| 02-01-XX | 01 | 1 | CAP-01 | T-02-WEBHOOK-01 | grammY webhook secret-token validation + DLQ wired | unit+integration | `pnpm --filter @kos/service-telegram-bot test -- --run && pnpm --filter @kos/cdk test -- --run capture-stack` | ❌ W0 | ⬜ pending |
| 02-02-XX | 02 | 1 | CAP-01 | T-02-TRANSCRIBE-01 | transcribe-starter + transcribe-complete Lambdas round-trip; event emitted to kos.capture | unit+integration | `pnpm --filter @kos/service-transcribe-* test -- --run && node scripts/verify-transcribe-event.mjs` | ❌ W0 | ⬜ pending |
| 02-03-XX | 03 | 1 | ENT-09, hybrid scoring | T-02-RESOLVER-01 | @kos/resolver library: hybrid score matches spec; migration 0003 applies; HNSW + pg_trgm indexes live | unit+integration | `pnpm --filter @kos/resolver test -- --run && KOS_DB_TUNNEL_PORT=15432 bash scripts/db-migrate-0003.sh` | ❌ W0 | ⬜ pending |
| 02-04-XX | 04 | 2 | AGT-01, AGT-02 | T-02-TRIAGE-01 | Triage + voice-capture Lambdas use Agent SDK on Bedrock Haiku 4.5; Langfuse traces emitted; capture_id idempotency | unit+integration | `pnpm --filter @kos/service-triage test -- --run && pnpm --filter @kos/service-voice-capture test -- --run` | ❌ W0 | ⬜ pending |
| 02-05-XX | 05 | 2 | AGT-03, ENT-09 | T-02-RESOLVER-02 | Entity-resolver Lambda calls @kos/resolver; Sonnet 4.6 disambiguation path; Inbox fallback | unit+integration | `pnpm --filter @kos/service-entity-resolver test -- --run && node scripts/verify-resolver-e2e.mjs` | ❌ W0 | ⬜ pending |
| 02-06-XX | 06 | 2 | CAP-01 ack | T-02-ACK-01 | push-telegram extension: is_reply bypasses cap + quiet hours; two-stage UX | unit | `pnpm --filter @kos/service-push-telegram test -- --run -- is-reply` | ❌ W0 | ⬜ pending |
| 02-07-XX | 07 | 2 | ENT-03, ENT-04 | — | KOS Inbox Notion DB created by bootstrap; Approve/Reject/Merge flow indexed by notion-indexer | integration | `node scripts/bootstrap-notion-dbs.mjs && node scripts/verify-kos-inbox-schema.mjs` | ❌ W0 | ⬜ pending |
| 02-08-XX | 08 | 3 | ENT-05 | T-02-BULK-01 | Kontakter import Lambda → KOS Inbox with idempotency | integration | `bash scripts/bulk-import-kontakter.sh --dry-run && node scripts/verify-inbox-count.mjs` | ❌ W0 | ⬜ pending |
| 02-09-XX | 09 | 3 | ENT-06 | T-02-BULK-02 | Gmail + Granola import Lambda → KOS Inbox (Granola may be partial per Open Question 1) | integration | `bash scripts/bulk-import-granola-gmail.sh --dry-run` | ❌ W0 | ⬜ pending |
| 02-10-XX | 10 | 3 | Observability | — | Langfuse + Sentry wired across all agent Lambdas; secrets in Secrets Manager | integration | `node scripts/verify-observability.mjs` (traces + Sentry events present) | ❌ W0 | ⬜ pending |
| 02-11-XX | 11 | 4 | Phase 2a completion | — | E2E integration test: fake Telegram update → all Lambdas fire → Notion row + Telegram ack | integration | `node scripts/verify-phase-2-e2e.mjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Phase 2b (Kevin's usage week + vocab iteration) lives in a separate validation matrix generated at Phase 2b open.

---

## Wave 0 Requirements

- [ ] `packages/resolver/package.json` — new workspace package for hybrid scoring library + SQL templates
- [ ] `services/telegram-bot/` — grammY on Lambda webhook
- [ ] `services/transcribe-starter/` — captures voice S3 events → StartTranscriptionJob
- [ ] `services/transcribe-complete/` — Transcribe Job State Change → capture.voice.transcribed
- [ ] `services/triage/` — Haiku 4.5 triage agent (Claude Agent SDK)
- [ ] `services/voice-capture/` — Haiku 4.5 classify + Notion row write
- [ ] `services/entity-resolver/` — Sonnet 4.6 three-stage resolver
- [ ] `services/bulk-import-kontakter/` — one-shot
- [ ] `services/bulk-import-granola-gmail/` — one-shot
- [ ] `packages/db/drizzle/0003_cohere_embedding_dim.sql` — 1536 → 1024 + embedding_model column
- [ ] `packages/db/drizzle/0004_pg_trgm_indexes.sql` — gin_trgm_ops on entity_index + `kevin_context`
- [ ] `scripts/bootstrap-notion-dbs.mjs` — extend with KOS Inbox DB creation
- [ ] `scripts/verify-phase-2-e2e.mjs` — end-to-end sanity
- [ ] `scripts/verify-transcribe-event.mjs` — round-trip synthetic audio
- [ ] `scripts/verify-resolver-e2e.mjs` — resolver correctness
- [ ] `scripts/verify-kos-inbox-schema.mjs` — Inbox properties + indexer wiring
- [ ] `scripts/verify-observability.mjs` — Langfuse + Sentry smoke
- [ ] Shared test fixtures: mock Bedrock, mock Telegram update, mock Notion client
- [ ] Secrets Manager: `kos/langfuse-public-key`, `kos/langfuse-secret-key`, `kos/sentry-dsn`, `kos/telegram-webhook-secret`, `kos/gmail-oauth-tokens`, `kos/granola-api-key`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Telegram bot created via @BotFather | CAP-01 | Requires human interaction with @BotFather UI | 1. Talk to @BotFather. 2. /newbot; name "K-OS"; username "kos_kevin_bot". 3. Paste token into `kos/telegram-bot-token` via seed-secrets. 4. Run `npx tsx scripts/register-telegram-webhook.ts`. |
| Gmail OAuth consent | ENT-06 | Requires Kevin to click through Google OAuth | 1. Run `npx tsx scripts/gmail-oauth-init.ts`. 2. Follow printed URL. 3. Paste code back. 4. Tokens written to `kos/gmail-oauth-tokens` in Secrets Manager. |
| Kevin's-gut transcript validation | INF-08 (replacement for WER) | Entire Phase 2b premise — Kevin subjectively judges transcripts over 1 week | 1. Use bot daily. 2. Keep running note of mis-transcribed terms. 3. At end of week, append to `vocab/sv-se-v1.txt` and redeploy. 4. Flip Phase 2b status to ✅ when Kevin reports "usable enough to trust Notion writes". |
| Notion Inbox batch approval workflow | ENT-03, ENT-04 | Depends on Kevin using Notion to Approve/Reject/Merge | 1. Trigger bulk import. 2. Confirm ≥ 50 candidates in KOS Inbox DB. 3. Batch-approve at least 10 to validate indexer commit path. 4. Verify entity_index rows appear within 10 min. |
| Granola REST access | ENT-06 | Kevin must obtain API key OR approve Notion-Transkripten fallback | One-time: Kevin provides `kos/granola-api-key` OR decision to use Transkripten DB is recorded. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 120 s (unit) / < 10 min (integration)
- [ ] `nyquist_compliant: true` set in frontmatter after planner finalises Task IDs

**Approval:** pending
