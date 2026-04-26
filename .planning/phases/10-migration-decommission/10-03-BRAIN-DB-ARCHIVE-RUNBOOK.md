# Plan 10-03 — Brain DB Archive Runbook (MIG-03)

**Owner:** Kevin (operator) | **Phase:** 10 Wave 2 | **Risk class:** Reversible within 90 days
**Pre-req:** Wave 1 (classify-adapter) soaked clean for >= 1 hour | **Sibling:** Plan 10-04 (Discord migration, parallel)

This runbook walks the operator through archiving the 5 legacy Brain DBs in
Notion with a write-ahead audit trail. The action is reversible:

1. Notion's trash retains archived databases for 30-90 days (workspace tier
   dependent), restorable via UI or API.
2. The `event_log` row written BEFORE every Notion mutation preserves the
   pre-archive title forever, so even after Notion's trash window the
   original title is recoverable.

**This runbook NEVER deletes data.** Any step that could destroy data is
explicitly called out.

---

## Pre-archive (T-24h)

### 1. MIG-04 confirmation — Command Center is the live task substrate

The 167 rows migrated to Command Center in Phase 1 must remain untouched.

```bash
# Verifier prints "[INFO] MIG-04 OK: Command Center has N rows" — N must be >= 167.
node scripts/verify-brain-dbs-archived.mjs
```

If the verifier reports MIG-04 < 167 BEFORE the archive runs, STOP and
investigate. The archive script does not touch Command Center, so a row
shortage means an upstream regression (likely an indexer bug).

### 2. Populate the Brain DB inventory

```bash
cp scripts/.notion-brain-dbs.example.json scripts/.notion-brain-dbs.json
```

Edit `scripts/.notion-brain-dbs.json` and replace each
`REPLACE_WITH_NOTION_UUID_*` placeholder with the real Notion database
UUID. Find the UUIDs by:

- Opening each Brain DB in Notion → Share → Copy link → extract the 32-char
  hex from `https://notion.so/<workspace>/<DB-NAME>-<32-hex>?v=...`.
- Or running `node scripts/discover-notion-dbs.mjs --db <name>` if the DB
  title is exact.

`scripts/.notion-brain-dbs.json` is gitignored — do NOT commit real UUIDs.

### 3. Dry-run

```bash
node scripts/migrate-brain-dbs.mjs --dry-run
```

Output: 5 `[DRY]` lines showing the proposed `[MIGRERAD-YYYY-MM-DD] <title>`.
No event_log writes. No Notion mutations. Review the proposed titles for
typos / unexpected DBs.

---

## T-0 archival (~2 min wall-clock)

### 1. Resolve secrets

```bash
export NOTION_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id kos/notion-integration-token \
  --query SecretString --output text)

export RDS_URL=$(aws secretsmanager get-secret-value \
  --secret-id kos/rds-admin-url \
  --query SecretString --output text)
```

If the operator runs from outside AWS (laptop), use the `db-push.sh` SSH
tunnel and set `KOS_DB_TUNNEL_PORT` instead of `RDS_URL`.

### 2. Execute archive

```bash
node scripts/migrate-brain-dbs.mjs
```

**Expected output:**

```
[migrate-brain-dbs] EXECUTE targets=5 owner=<UUID> force=false
[OK]   <uuid-1>  Brain DB Personal: archived (412ms) event_log=<id-1>
         "Brain DB Personal" → "[MIGRERAD-2026-04-25] Brain DB Personal"
[OK]   <uuid-2>  Brain DB Tale Forge: archived (380ms) event_log=<id-2>
         ...
[OK]   <uuid-3>  Brain DB Outbehaving: ...
[OK]   <uuid-4>  Brain DB Almi: ...
[OK]   <uuid-5>  Brain DB Inbox: ...

[DONE] archived=5 skipped=0 errors=0 (of 5 target)
```

If any DB errors, the script keeps going for the rest. The
`event_log` audit row for the failed DB stays committed (write-ahead
intent). Retry the failed one with `--db-id <uuid>` after fixing the root
cause. Use `--force` if the DB partially landed.

---

## T+5min verification

### 1. Run verifier

```bash
node scripts/verify-brain-dbs-archived.mjs
```

**Expected:** 5/5 `[PASS]` lines + `[INFO] MIG-04 OK` + final
`[SUMMARY] pass=5 fail=0 of 5`. Exits 0.

The verifier asserts per DB:
- `archived === true` in Notion
- title starts with `[MIGRERAD-YYYY-MM-DD]`
- event_log has at least 1 row with `kind='brain-db-archived'` AND
  `detail ? 'notion_ack_at'` (the confirmation write-back)

### 2. Run ordering invariant test

```bash
node scripts/verify-brain-db-archive-ordering.mjs
```

**Expected:** 5/5 ordering assertions pass. This validates the
archival function obeys D-12 (audit-write BEFORE Notion mutation) on
both happy + failure paths via mocks. Run any time as a regression
guard — does NOT touch real Notion or RDS.

### 3. Notion UI cross-check

- Open Notion in a browser.
- Search for `[MIGRERAD-` — confirm 5 DBs appear (in workspace Trash).
- Verify each has the correct date prefix.

### 4. Manual Lock database step (P-11 mitigation)

The Notion API does NOT expose the "Lock database" toggle (per
10-RESEARCH.md §2). For each archived DB:

1. Open the DB in Notion (still findable in Trash by title prefix).
2. Click the `•••` menu in the upper right.
3. Click **Lock database**.

This prevents schema drift during the 90-day trash window — anyone with
edit access cannot accidentally rename or restructure a frozen DB.

---

## Rollback within 90 days

Three rollback paths, in order of operator preference:

### Path A — Notion UI (preferred)

1. Notion → Settings → Trash.
2. Find the DB by `[MIGRERAD-` title prefix.
3. Click **Restore**.
4. Manually rename: strip the `[MIGRERAD-YYYY-MM-DD] ` prefix from the title.
5. Optional: turn off Lock database.

### Path B — Notion API

```bash
node -e "
import('@notionhq/client').then(async ({ Client }) => {
  const n = new Client({ auth: process.env.NOTION_TOKEN });
  const r = await n.databases.update({
    database_id: '<uuid>',
    archived: false,
    title: [{ type: 'text', text: { content: '<original title from event_log>' } }],
  });
  console.log('restored:', r.id);
});
"
```

### Path C — Recover original title from event_log

```sql
SELECT detail->>'original_title' AS original_title,
       detail->>'new_title'      AS migrerat_title,
       occurred_at
  FROM event_log
 WHERE kind = 'brain-db-archived'
   AND detail->>'database_id' = '<uuid>'
 ORDER BY occurred_at DESC
 LIMIT 1;
```

The `event_log.detail.original_title` is the source of truth for the
pre-archive name even if Notion is fully unavailable.

---

## Rollback after 90 days

- Notion auto-empties trash at 30 days (Pro tier) or 90 days (Enterprise
  tier). The DB is permanently deleted from the workspace.
- The `event_log` row remains forever as the historical record.
- Recovery options:
  1. Notion support ticket → may restore from backup; not guaranteed.
  2. The audit row's `original_title` lets the operator manually recreate
     a stub DB with the same name.

**Action to never let this happen:** at T-0, schedule a 60-day calendar
reminder to decide between (a) un-archive permanently, (b) accept the
delete. Do NOT let the 90-day window expire by inattention.

---

## MIG-04 re-confirmation (post-archive)

Re-run after the 5/5 PASS:

```bash
node scripts/verify-brain-dbs-archived.mjs   # reads MIG-04 row count again
```

Expected `[INFO] MIG-04 OK` line with row count >= 167. If the count
dropped, investigate immediately — the Brain DB archive script was NOT the
cause (it never queries Command Center) but a regression elsewhere may
have shipped concurrently.

Also run:

```bash
# Confirm no agent code references any of the 5 archived Brain DB UUIDs.
# (If a reference exists, that agent will start failing — should already
# have been caught at Phase 1, but cheap to recheck.)
grep -rn -F -f <(node -e "
const j = JSON.parse(require('node:fs').readFileSync('scripts/.notion-brain-dbs.json','utf8'));
console.log(j.brain_dbs.map(d => d.id).join('\n'));
") services/ packages/ || echo '[OK] no agent code references the 5 archived Brain DB UUIDs'
```

---

## Operator sign-off

Once 5/5 PASS, MIG-04 OK, and Lock database applied to all 5:

- [ ] T-0 archive complete
- [ ] T+5min verifier 5/5 PASS
- [ ] T+5min ordering invariant test PASS
- [ ] Manual Lock database applied (5/5)
- [ ] MIG-04 re-confirmation OK
- [ ] 60-day calendar reminder set (decide un-archive vs hard-delete)

# DRY_RUN_EVIDENCE:

(Operator: paste dry-run output here before live archive runs. Captures
the exact 5 UUIDs + proposed titles for the audit trail.)

```
$ node scripts/migrate-brain-dbs.mjs --dry-run
[migrate-brain-dbs] DRY-RUN targets=5 owner=<UUID> force=false
[DRY] <uuid-1>  (active)             "Brain DB Personal" → "[MIGRERAD-YYYY-MM-DD] Brain DB Personal"
[DRY] <uuid-2>  (active)             "..." → "..."
[DRY] <uuid-3>  (active)             "..." → "..."
[DRY] <uuid-4>  (active)             "..." → "..."
[DRY] <uuid-5>  (active)             "..." → "..."
[DRY-DONE] inspected 5/5 (no writes performed).
```
