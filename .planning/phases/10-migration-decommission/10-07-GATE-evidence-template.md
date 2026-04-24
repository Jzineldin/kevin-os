---
phase: 10-migration-decommission
plan: 07
type: gate-evidence-template
created: 2026-04-24
operator_populates_at: Wave 4 gate time (after T+14 clean-ops streak)
---

# Phase 10 Gate Evidence

**Collected:** <YYYY-MM-DD>
**Operator:** <name>
**Verifier runs:** `scripts/verify-phase-10-e2e.mjs` output + upstream verifier evidence paths.

---

## SC 1 — MIG-01 Same-Substance (7 days × 3 scripts × 10 cases)

| Day | classify_and_save (≥8/10) | morning_briefing (≥8/10) | evening_checkin (≥8/10) | Kevin sign-off |
|-----|---------------------------|---------------------------|--------------------------|----------------|
| D+1 |                           |                           |                          |                |
| D+2 |                           |                           |                          |                |
| D+3 |                           |                           |                          |                |
| D+4 |                           |                           |                          |                |
| D+5 |                           |                           |                          |                |
| D+6 |                           |                           |                          |                |
| D+7 |                           |                           |                          |                |

Pass threshold: ≥ 8/10 per script per day, for 7 consecutive days. Kevin signs off per row.

Evidence path: `.planning/phases/10-migration-decommission/classify-substance-evidence.json`

---

## SC 2 — MIG-02 n8n Dead

```
$ nc -zv 98.91.6.66 5678
<paste output>

$ node scripts/verify-n8n-dead.mjs
<paste output>
```

Expected: both report connection refused.

Also: n8n workflows archived to S3 bucket prefix `archive/n8n-workflows/<timestamp>/`. Event log row `kind=n8n-workflows-archived` + `kind=n8n-stopped`.

---

## SC 3 — MIG-03 Brain DBs Archived

| DB | Notion ID | archived=true | title starts with `[MIGRERAD-` | event_log row ID |
|----|-----------|---------------|--------------------------------|------------------|
| Brain-Inbox      |  |  |  |  |
| Brain-Projects   |  |  |  |  |
| Brain-Notes      |  |  |  |  |
| Brain-Journal    |  |  |  |  |
| Brain-Tasks      |  |  |  |  |

```
$ node scripts/verify-brain-dbs-archived.mjs
<paste output>
```

MIG-04 confirmation: Command Center remains the live task substrate; 167 migrated rows still readable by KOS (query `SELECT count(*) FROM command_center_rows` or equivalent).

---

## SC 4 — INF-11 VPS Dead + CAP-10 Discord Working

**VPS external probe:**
```
$ node scripts/verify-hetzner-dead.mjs
<paste output>
```

**Hetzner billing — 14-day observation:**
| Day | VM usage (€) | Snapshot storage (€) |
|-----|--------------|-----------------------|
| T+1 |              |                       |
| T+2 |              |                       |
| ... |              |                       |
| T+14 |             |                       |

Pass: VM usage = €0.00 for all 14 days; snapshot storage ~€0.012/GB-month is expected.

**CAP-10 Discord Lambda 7-day same-substance:**
```
$ node scripts/verify-discord-brain-dump-substance.mjs
<paste output>
```

**All 4 unfrozen VPS scripts retired:**
```
$ node scripts/verify-unfrozen-scripts-retired.mjs
<paste output>
```

---

## SC 5 — Rollback Runbook + Dry-Run

**Rollback runbook:** `.planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md` exists with DRY_RUN_EVIDENCE section populated.

**Dry-run rehearsal date:** <YYYY-MM-DD>
**Dry-run time to SSH-responsive:** <min:sec>
**Dry-run time to systemd units active:** <min:sec>
**Dry-run total time:** <min:sec> (target < 30 min)
**Dry-run evidence commit SHA:** <SHA>

```
$ grep -A 5 "DRY_RUN_EVIDENCE" .planning/phases/10-migration-decommission/10-ROLLBACK-RUNBOOK.md
<paste runbook evidence section — must be non-trivially populated>
```

---

## Bonus — Telegram Webhook Persistence (resolves 02-VERIFICATION.md M1)

```
$ node scripts/verify-telegram-webhook-persistence.mjs
<paste output>
```

**Outcome:**
- [ ] **PASS** — webhook URL persists > 60s post-decom → M1 RESOLVED via MIG-02 + INF-11 closure.
- [ ] **ESCALATE** — webhook cleared < 60s → run bot-token rotation per `.planning/debug/telegram-webhook-auto-clear.md` Test 3. Record rotation event_log row.

**Cross-reference for post-rotation state:** `.planning/debug/telegram-webhook-auto-clear.md` + `.planning/v1.0-MILESTONE-AUDIT.md` M1.

---

## event_log audit summary (queried at gate time)

```sql
SELECT kind, count(*) FROM event_log
 WHERE at > '<Phase 10 Wave 1 start>'
 GROUP BY kind ORDER BY kind;
```

Expected rows (minimum counts):
- `brain-db-archived`: 5
- `hetzner-snapshot-created`: 1
- `n8n-workflows-archived`: 1
- `n8n-stopped`: 1
- `vps-powered-down`: 1
- `vps-service-stopped`: ≥ 7 (3 frozen + 4 unfrozen)
- `phase-10-gate-passed`: 1 (emitted by verify-phase-10-e2e.mjs on all-green)

---

## Final Verdict

- [ ] All 5 SCs GREEN → Phase 10 DONE → apply ROADMAP promotion patch (MIG-01, MIG-02, MIG-03, MIG-04, INF-11, CAP-10 → `Verified`).
- [ ] Any SC FAIL → document in 10-07-SUMMARY.md + raise in next session (may become `/gsd-plan-phase 10 --gaps`).

**Operator signature:** <name + timestamp>
**Kevin approval:** <signature / Telegram message link>
**Gate passed SHA:** <git SHA of the commit where verify-phase-10-e2e.mjs exited 0>
