---
phase: 10-migration-decommission
type: context
created: 2026-04-24
mode: yolo (Kevin asleep — recommended defaults locked verbatim)
decisions_locked: 24
gray_areas_resolved: 7
---

# Phase 10 CONTEXT — Migration & Decommission

This phase finishes the job Phase 1 started. Phase 1 froze 3 VPS scripts (`classify_and_save`, `morning_briefing`, `evening_checkin`) to write to the Notion Legacy Inbox with `[MIGRERAD]` markers and documented `/opt/kos-vps/original/` as the rollback floor. Phase 10 retires those scripts, retires the 4 unfrozen VPS scripts (`brain_server`, `gmail_classifier`, `brain-dump-listener`, `sync_aggregated`), kills n8n on port 5678 (likely rogue caller per `.planning/debug/telegram-webhook-auto-clear.md`), archives the 5 Brain DBs in Notion with `Status=Archived` + `[MIGRERAD-<date>]` title prefix (NEVER delete), and powers down the Hetzner VPS after a 14-day same-substance verification window.

This phase is a **cost reduction** — steady-state Hetzner spend (~$50/mo) drops to zero after power-down. Monthly delta: -$50 from decom, +$0.50 for 30-day Hetzner snapshot retention = net -$49.50/mo.

---

## Locked Decisions (NON-NEGOTIABLE)

### Core architectural decisions (from parent phases + ROADMAP + PROJECT.md)

- **D-01 (Locked #12 from STATE.md):** Archive-never-delete is an invariant. Every migration step is reversible. The 5 Brain DBs remain in Notion's 90-day trash window after archival — do NOT empty trash. Hetzner snapshot retained 30 days post-power-down.
- **D-02 (ROADMAP SC 5):** Rollback plan exists and is rehearsed. Documented procedure to re-spin VPS from Hetzner snapshot in < 30 min, dry-run rehearsed before power-down.
- **D-03 (ROADMAP SC 1):** Same-substance verification runs for 7 consecutive days. 10 sample cases per script, hand-compared by Kevin (machine-assisted but not machine-decided).
- **D-04 (REQUIREMENTS MIG-04):** Command Center is the live task substrate. 167 rows migrated to Command Center are read by KOS as the source. Phase 10 does not touch CC row contents.
- **D-05 (PROJECT.md + CLAUDE.md):** 7 known VPS processes — `brain_server`, `classify_and_save` [patched], `morning_briefing` [patched], `evening_checkin` [patched], `gmail_classifier`, `brain-dump-listener`, `sync_aggregated`, plus n8n on port 5678 [unauth]. All 7 + n8n must be stopped + systemd-disabled before power-down.
- **D-06 (dependency chain):** Phase 10 depends on Phase 7 (AUTO-01 morning-brief + AUTO-03 day-close Lambdas) and Phase 4 (email-triage replaces `gmail_classifier`). Overlaps allowed with Phases 6/7/8 per ROADMAP; Phase 10 Wave 3 (n8n decom) waits until Phase 4 Gate 3 passes.
- **D-07 (debug/telegram-webhook-auto-clear.md):** MIG-02 + INF-11 closure is the primary mitigation for the Telegram webhook auto-clear issue. Phase 10 includes a post-decom webhook persistence re-test.
- **D-08 (Locked #1):** EventBridge-only event routing. No replacement n8n. `classify_and_save` adapter Lambda publishes `capture.received`; does NOT call agents directly.
- **D-09 (cost target $200-400/mo, currently ~$50 Hetzner = 12-25% savings):** Phase 10 delivers savings; snapshot retention cost is explicit.
- **D-10 (Locked #2):** Notion is source of truth. Brain DB archival mutates Notion metadata (Status, title). Postgres event_log audit trail is derived.
- **D-11 (INF-11 strict reading):** "Powered down" = `hetzner server power_off`, NOT `hetzner server delete`. Power-off preserves the 30-day snapshot as the reversibility floor.
- **D-12 (MIG-03 archival atomicity):** Each Brain DB archival writes an `event_log` row BEFORE the Notion mutation (write-ahead audit). If Notion call fails, audit row still proves intent. If audit write fails, don't mutate Notion.

### Phase-specific decisions

- **D-13 (migration number):** Phase 10 migration is `0016_phase_10_migration_audit.sql`. Bump to 0017 if any prior phase's migration lands later at execution time.
- **D-14 (VPS script discovery approach):** Phase 10 Wave 0 ships `scripts/discover-vps-scripts.sh` — operator-run via SSH to `kevin@98.91.6.66`. Output is a JSON file persisted to `.planning/phases/10-migration-decommission/vps-service-inventory.json`. Phase 10 waves 3+4 read this inventory to know exactly which systemd units to disable.
- **D-15 (Hetzner snapshot retention):** 30 days post-power-down. Day-15: operator may delete if 14 consecutive days of clean KOS operation. Day-30: hard delete by operator (documented in runbook).
- **D-16 (power-down sequencing):** VPS stays running-but-inert during the 14-day same-substance overlap (7 days parity + 7 days cold failover). Power-down at day 15 after written sign-off from Kevin.
- **D-17 (archive timing):** MIG-03 archival runs after Phase 2 Gate 2 has been re-issued PASS (already true per STATE.md). Brain DBs have been write-frozen since Phase 1 (VPS scripts write to Legacy Inbox, not Brain DBs). Archive can proceed without waiting for VPS decom.
- **D-18 (event_log table):** Migration 0016 creates a generic `event_log` table if it doesn't already exist. Columns: `id UUID`, `owner_id TEXT`, `kind TEXT`, `details JSONB`, `at TIMESTAMPTZ`, `actor TEXT`. Used by MIG-03 (kind: `brain-db-archived`) and INF-11 (kind: `vps-service-stopped`, `vps-powered-down`, `hetzner-snapshot-deleted`).
- **D-19 (same-substance verifier implementation):** `scripts/verify-classify-substance.mjs` uses Gemini 2.5 Pro (Vertex AI per Phase 6 INF-10 + Locked #3 revision) to judge semantic equivalence pairs. Output is a confidence score per pair + operator hand-review checklist. Pure LLM judgment never passes the gate alone; Kevin signs off on 10 pairs per script.
- **D-20 (n8n workflow archive format):** JSON export to S3 (`s3://<kos-blobs-bucket>/archive/n8n-workflows/<timestamp>/`) with KMS encryption + IAM restricted to operator role. Audit row in `event_log` kind `n8n-workflows-archived` with per-workflow SHA-256.
- **D-21 (Discord brain-dump-listener migration):** Discord channel webhook (inbound to Lambda URL) rather than bot polling. Single-user channel so no scaling concern. Operator configures Discord channel → webhook URL pointing at Lambda Function URL + HMAC auth.
- **D-22 (Telegram webhook re-test):** After MIG-02 + INF-11 both complete, Phase 10 Wave 4 includes a mandatory re-test — `setWebhook` + `sleep 60 && getWebhookInfo`. If `url` is still empty after 60s, escalate per `telegram-webhook-auto-clear.md` (dev machine hunt or bot token rotation).
- **D-23 (dual-write risk during overlap):** During 14-day overlap the VPS classify-adapter Lambda replaces the VPS classify_and_save.py as the classify webhook endpoint. Both cannot fire for the same input. Operator flips DNS / webhook URL atomically (single cutover moment). Old VPS scripts remain systemd-disabled during the overlap; snapshot restore is the only rollback.
- **D-24 (cost explorer egress check):** INF-11 closure requires AWS Cost Explorer filtered by Hetzner-related egress shows $0 for 14 consecutive days. Since AWS Cost Explorer does NOT track Hetzner egress (Hetzner isn't an AWS service), the actual check is: Hetzner billing dashboard shows zero VM usage for 14 consecutive days. Documented as operator runbook step (not Lambda-automatable).

---

## Gray Areas — Recommended Defaults All Locked

All 7 orchestrator recommended defaults are accepted verbatim per yolo mode + Kevin-asleep brief:

| # | Gray Area | Default | Locked? |
|---|-----------|---------|---------|
| G-01 | classify_and_save migration shape | Thin adapter Lambda (not full rewrite, not delete) — keeps old VPS webhook URL functional during 14-day overlap; adapter translates old payload → `capture.received` | YES |
| G-02 | gmail_classifier replacement | Decommission entirely in same step as Phase 4 Gate 3 pass; no adapter (was inbox-polling; now EmailEngine IMAP IDLE) | YES |
| G-03 | brain-dump-listener migration | Lambda with Discord channel webhook (not bot polling) | YES |
| G-04 | n8n workflow archive format | JSON export to S3 + human review checklist (not code compilation) | YES |
| G-05 | Archive timing (MIG-03) | Immediately after Phase 2 Gate 2 reissues PASS (already true) | YES |
| G-06 | Power-down sequencing | AFTER 14-day same-substance verification (VPS runs cold-inert during overlap) | YES |
| G-07 | Hetzner snapshot retention | 30 days (14-day verify + 16-day buffer) | YES |

---

## Scope

### In scope

- **MIG-01:** classify_and_save → thin adapter Lambda. morning_briefing + evening_checkin retired in favor of Phase 7 AUTO-01/AUTO-03. 7-day same-substance verification (hand-compared).
- **MIG-02:** n8n on port 5678 decommissioned. Workflows exported to S3 for audit. Port 5678 firewall DROP. External probe returns `Connection refused`.
- **MIG-03:** 5 Brain DBs archived — `Status=Archived`, title prefixed `[MIGRERAD-<date>]`, `event_log` audit row per DB, Notion lock-database enabled, 90-day trash window preserved.
- **MIG-04 (archive):** formal archival marker applied (Phase 1 already applied the freeze; this plan closes the loop).
- **INF-11:** Hetzner VPS at 98.91.6.66 powered down. All 7 services + n8n stopped + systemd-disabled. Snapshot taken + stored 30 days. Hetzner billing → $0.
- **CAP-10:** Discord brain-dump-listener → Lambda w/ Discord channel webhook; same-substance verified 7 days.
- **Rollback runbook:** `10-ROLLBACK-RUNBOOK.md` with <30min restore procedure + dry-run evidence.
- **Telegram webhook rogue-caller closure:** post-decom re-test + escalation path if still reproducing.

### Out of scope (deferred / other phases)

- **Notion 5 Brain DB un-archival** — out of scope by design; single-direction archive.
- **Auto-compiling n8n workflows into EventBridge rules** — deferred; if any workflow is found essential during archive review, operator opens a new plan.
- **Hetzner account closure** — deferred to milestone cleanup; Phase 10 only stops the VPS, doesn't cancel the Hetzner account (other side projects may use it).
- **Postgres RDS point-in-time restore for event_log** — assumed present via Phase 1 data-stack defaults; not newly introduced here.

---

## Dependencies on prior phases

| Dep | Phase | Artifact |
|-----|-------|----------|
| classify-adapter calls triage + voice-capture | 2 | services/triage + services/voice-capture Lambdas |
| morning-brief replaces morning_briefing.py | 7 | services/morning-brief (AUTO-01) |
| day-close replaces evening_checkin.py | 7 | services/day-close (AUTO-03) |
| email-triage replaces gmail_classifier.py | 4 | services/email-triage (AGT-05) |
| context-loader for classify-adapter (entity context) | 6 | @kos/context-loader |
| event_log table + RDS proxy access | 1 | DataStack + migration chain |
| Legacy Inbox DB (referenced by stopped scripts) | 1 | Notion Legacy Inbox |
| EventBridge bus `kos.capture` | 1 | EventsStack |

**Hard prereq for Wave 3 (n8n decom):** Phase 4 Gate 3 PASS (email-triage verified replacing gmail_classifier).
**Hard prereq for Wave 4 (power-down):** Wave 1 same-substance verification 7-day clean + Wave 2 Brain DB archival committed + Wave 3 n8n + unfrozen-scripts decom all complete + +7-day cold-failover window elapsed.

---

## Plan Structure

| Plan | Wave | Focus |
|------|------|-------|
| 10-00 | 0 | Scaffold: 3 Lambda skeletons + 3 scripts + migration 0016 + test fixtures |
| 10-01 | 1 | MIG-01: classify adapter Lambda + same-substance verifier (Gemini 2.5 Pro judge) |
| 10-02 | 1 (parallel) | MIG-01: morning_briefing + evening_checkin retirement + vps-redirect-legacy cutover |
| 10-03 | 2 | MIG-03: 5 Brain DB archival (scripts/migrate-brain-dbs.mjs) |
| 10-04 | 2 (parallel) | CAP-10: Discord brain-dump-listener Lambda + 7-day same-substance verifier |
| 10-05 | 3 | MIG-02: n8n workflow export → S3 → stop/disable n8n → iptables DROP port 5678 → external probe |
| 10-06 | 3 (parallel) | INF-11: retire 4 unfrozen VPS scripts (gmail_classifier, brain_server, sync_aggregated, brain-dump-listener) |
| 10-07 | 4 | INF-11: Hetzner snapshot + power-off + 14-day cost verification + rollback runbook + Telegram webhook re-test |

**Total:** 8 plans across 4 waves (not counting the ROLLBACK-RUNBOOK artifact which ships with 10-07).

---

## Files authored by this phase

### Services

- `services/vps-classify-migration/` — MIG-01 classify_and_save thin adapter Lambda
- `services/discord-brain-dump/` — CAP-10 Discord channel webhook → Lambda → capture.received
- `services/n8n-workflow-archiver/` — one-shot Lambda invoked by scripts/decom-n8n.sh; exports n8n workflows to S3 before shutdown

### Scripts

- `scripts/discover-vps-scripts.sh` — operator-run SSH discovery (populates `.planning/phases/10-migration-decommission/vps-service-inventory.json`)
- `scripts/migrate-brain-dbs.mjs` — Notion API archival for 5 Brain DBs
- `scripts/decom-n8n.sh` — operator-run SSH n8n shutdown + port closure
- `scripts/retire-vps-script.sh` — generic per-script systemd stop + disable
- `scripts/power-down-hetzner.sh` — Hetzner CLI snapshot + power-off
- `scripts/verify-hetzner-dead.mjs` — external probe (expects no open ports on 98.91.6.66)
- `scripts/verify-classify-substance.mjs` — 7-day same-substance verifier (Gemini-judged, operator-approved)
- `scripts/verify-discord-brain-dump-substance.mjs` — 7-day same-substance verifier
- `scripts/verify-n8n-dead.mjs` — external probe expects port 5678 → Connection refused
- `scripts/verify-telegram-webhook-persistence.mjs` — post-decom re-test
- `scripts/verify-phase-10-e2e.mjs` — gate verifier (all 5 ROADMAP SCs)

### Database

- `packages/db/drizzle/0016_phase_10_migration_audit.sql` — event_log table (if not exists) + indexes

### CDK

- `packages/cdk/lib/stacks/integrations-migration.ts` — CDK constructs for 3 Lambdas + Lambda Function URL for Discord webhook + IAM roles

### Planning artifacts

- `.planning/phases/10-migration-decommission/10-CONTEXT.md` (this file)
- `.planning/phases/10-migration-decommission/10-RESEARCH.md`
- `.planning/phases/10-migration-decommission/10-VALIDATION.md`
- `.planning/phases/10-migration-decommission/10-00-PLAN.md` through `10-07-PLAN.md`
- `.planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md`
- `.planning/phases/10-migration-decommission/10-DISCUSSION-LOG.md`
- `.planning/phases/10-migration-decommission/vps-service-inventory.json` (operator-populated at execution time)

---

## Known Risks

| Risk | Mitigation |
|------|------------|
| A scheduled task on Hetzner still holds the Telegram bot token after decom | Bot token rotation is the nuclear option per debug doc; documented in Telegram re-test step |
| Notion "lock database" may also prevent restore | MIG-03 archival uses Status=Archived first, title-prefix second, lock-database LAST — order preserves 90-day trash reversibility |
| Hetzner power-off may preserve IP — IP reassignment + someone else binding to 98.91.6.66 could respond to probes | Post-power-down probe expects either Connection refused OR port-mismatch fingerprint; documented in verify-hetzner-dead.mjs |
| Sample size 10 cases per script may miss long-tail defects | Known limitation; gate accepts operator hand-review + 7-day window as the residual risk absorption |
| gmail_classifier replacement (Phase 4 email-triage) may lag if Phase 4 not yet executed | Wave 3 hard-prereqs Phase 4 Gate 3 PASS — if Phase 4 not ready, Phase 10 Wave 3 is blocked |
| Hetzner snapshot restoration can take 30-60 min depending on Hetzner load | Runbook budget is "< 30 min best-case; 60 min worst-case with explicit operator escalation to Hetzner support" |

---

## Acceptance (ties to ROADMAP SCs)

- [ ] SC 1 (MIG-01): 7 days identical-in-substance verified by Kevin (10 cases/script hand-compared)
- [ ] SC 2 (MIG-02): `nc -zv 98.91.6.66 5678` returns Connection refused
- [ ] SC 3 (MIG-03): 5 Brain DBs Status=Archived + `[MIGRERAD-YYYY-MM-DD]` + event_log rows; MIG-04 confirmed (CC live)
- [ ] SC 4 (INF-11): Hetzner VPS powered down; CAP-10 Discord Lambda forwarding to KOS webhook
- [ ] SC 5 (rollback): `10-ROLLBACK-RUNBOOK.md` exists + dry-run rehearsal log committed

**Bonus closure (non-SC):** Telegram webhook persists >60s post-decom (or escalation path triggered per debug doc).

---

## Deviations from recommended defaults

None. All 7 gray-area orchestrator recommendations accepted verbatim (G-01 through G-07).
