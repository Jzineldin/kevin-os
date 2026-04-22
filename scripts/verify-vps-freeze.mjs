#!/usr/bin/env node
/**
 * Gate 1 VPS freeze verifier (initial check).
 *
 * Proves:
 *   A. Legacy Inbox received ≥1 new row with [MIGRERAD] (or [SKIPPAT-DUP])
 *      marker since the trigger time.
 *   B. Command Center received ZERO rows whose properties reference the
 *      three patched script names since the trigger time.
 *
 * Trigger path:
 *   - systemctl restart on both candidate unit-name sets (kos-* and
 *     classify-and-save/morning-briefing/evening-checkin).
 *   - Supplementary: directly invoke each python script over SSH so we have
 *     a guaranteed single-execution per script even when systemd unit is
 *     long-running timer-driven and restart is a no-op.
 *
 * Mandatory env:
 *   NOTION_TOKEN            — Notion integration token
 *   COMMAND_CENTER_DB_ID    — either env or scripts/.notion-db-ids.json key
 *                             `commandCenter`. Fail fast if missing: the
 *                             freeze reverse-check IS the main guarantee
 *                             and silently skipping it is a Gate 1 trap.
 *
 * Optional env:
 *   VPS_HOST (default 98.91.6.66), VPS_USER (default kevin)
 *
 * Exit codes:
 *   0 — ok (both checks pass)
 *   1 — config error (missing env / ids)
 *   2 — Legacy Inbox empty (freeze didn't take effect)
 *   3 — Command Center leaked rows from patched scripts (freeze broken)
 *
 * Side effect: appends a `freeze-start` line to
 * `.planning/phases/01-infrastructure-foundation/vps-freeze-observation.log`
 * so the 48h verifier can confirm the observation window has elapsed.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('[FAIL] NOTION_TOKEN env required');
  process.exit(1);
}

const ID_FILE = 'scripts/.notion-db-ids.json';
const ids = existsSync(ID_FILE) ? JSON.parse(readFileSync(ID_FILE, 'utf8')) : {};

// MANDATORY: Command Center ID. If we can't verify the "zero leaks" direction,
// the test is worthless — fail fast rather than silently produce a false positive.
const ccId = process.env.COMMAND_CENTER_DB_ID || ids.commandCenter;
if (!ccId || ccId === 'pending-bootstrap') {
  console.error(
    '[FAIL] COMMAND_CENTER_DB_ID required (env var or scripts/.notion-db-ids.json key "commandCenter"). ' +
      'Freeze verification requires this to prove zero leaks.',
  );
  process.exit(1);
}

const legacyId = process.env.LEGACY_INBOX_DB_ID || ids.legacyInbox;
if (!legacyId || legacyId === 'pending-bootstrap') {
  console.error(
    '[FAIL] Legacy Inbox DB ID required (env LEGACY_INBOX_DB_ID or .notion-db-ids.json key "legacyInbox").',
  );
  process.exit(1);
}

const VPS = process.env.VPS_HOST ?? '98.91.6.66';
const VPS_USER = process.env.VPS_USER ?? 'kevin';

// We start the observation window NOW — any Legacy Inbox writes must be after
// this instant for the assertion to be meaningful (avoids picking up unrelated
// rows from a previous run).
const since = new Date(Date.now() - 60 * 1000).toISOString(); // -1min skew slack

// --- 1. Trigger VPS scripts -------------------------------------------------
// systemctl restart (not start — start is a no-op on active units); fall back
// to direct python3 invocation to guarantee at least one execution per script.
const trigger = [
  'sudo systemctl restart kos-classify kos-morning kos-evening 2>/dev/null || ',
  'sudo systemctl restart classify-and-save morning-briefing evening-checkin 2>/dev/null || true; ',
  'for f in classify_and_save morning_briefing evening_checkin; do ',
  '  sudo bash -c "set -a && . /etc/kos-freeze.env && set +a && python3 /opt/kos-vps/${f}.py < /dev/null" 2>/dev/null || true; ',
  'done',
].join('');

try {
  execSync(`ssh ${VPS_USER}@${VPS} '${trigger}'`, { stdio: 'inherit' });
} catch (err) {
  console.warn('[WARN] ssh trigger failed — VPS scripts may not have executed. Continuing to Notion-side assertions.');
  console.warn(String(err));
}

// --- 2. Wait for Notion writes to settle ------------------------------------
await new Promise((r) => setTimeout(r, 30_000));

// --- 3. Notion query helper -------------------------------------------------
async function notionQuery(dbId, afterIso) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { timestamp: 'created_time', created_time: { after: afterIso } },
      page_size: 100,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion query ${dbId} ${r.status}: ${text}`);
  }
  const j = await r.json();
  return j.results ?? [];
}

// --- 4. Legacy Inbox assertion ----------------------------------------------
const legacyRows = await notionQuery(legacyId, since);
const migrated = legacyRows.filter((row) => {
  const title = row.properties?.Name?.title?.[0]?.plain_text ?? '';
  return title.startsWith('[MIGRERAD]') || title.startsWith('[SKIPPAT-DUP]');
});
if (migrated.length < 1) {
  console.error(
    `[FAIL] No [MIGRERAD]/[SKIPPAT-DUP] rows in Legacy Inbox since ${since}. Patched scripts did not run or dropped writes.`,
  );
  process.exit(2);
}
// eslint-disable-next-line no-console
console.log(`[OK] Legacy Inbox received ${migrated.length} redirected row(s) since ${since}`);

// --- 5. Command Center reverse assertion (ZERO rows) ------------------------
const ccRows = await notionQuery(ccId, since);
const fromScripts = ccRows.filter((row) => {
  const serialised = JSON.stringify(row.properties ?? {});
  return (
    serialised.includes('classify_and_save') ||
    serialised.includes('morning_briefing') ||
    serialised.includes('evening_checkin')
  );
});
if (fromScripts.length > 0) {
  console.error(
    `[FAIL] Command Center received ${fromScripts.length} row(s) from patched scripts since ${since} — freeze broken.`,
  );
  process.exit(3);
}
// eslint-disable-next-line no-console
console.log(`[OK] Command Center received zero rows from patched scripts since ${since} (initial freeze check).`);

// --- 6. Observation log (for 48h verifier) ----------------------------------
const logPath = '.planning/phases/01-infrastructure-foundation/vps-freeze-observation.log';
mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, `${new Date().toISOString()} freeze-start commandCenter=${ccId}\n`);
// eslint-disable-next-line no-console
console.log(`[OK] Observation window started — see ${logPath} and run verify-vps-freeze-48h.mjs ≥48h from now.`);
