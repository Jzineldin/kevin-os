#!/usr/bin/env node
/**
 * Gate 1 VPS freeze verifier (48h observation close).
 *
 * Runs AT OR AFTER Gate 1 crossover, ≥48h after the first `verify-vps-freeze.mjs`
 * run. Reads the observation log to confirm the window has truly elapsed, then
 * asserts that the Command Center received ZERO rows from the patched scripts
 * during the entire window.
 *
 * Why a separate 48h check: the initial verifier proves the freeze took
 * effect on one invocation; it does NOT prove no cron-driven or timer-driven
 * run has leaked data since. D-14 requires 48h of quiet on Command Center.
 *
 * Mandatory env:
 *   NOTION_TOKEN
 *   COMMAND_CENTER_DB_ID (or scripts/.notion-db-ids.json `commandCenter`)
 *
 * Exit codes:
 *   0 — ok
 *   1 — config error OR observation window <48h (fails fast with "wait until X")
 *   2 — Command Center leaked rows from patched scripts
 */
import { readFileSync, existsSync } from 'node:fs';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('[FAIL] NOTION_TOKEN env required');
  process.exit(1);
}

const ID_FILE = 'scripts/.notion-db-ids.json';
const ids = existsSync(ID_FILE) ? JSON.parse(readFileSync(ID_FILE, 'utf8')) : {};
const ccId = process.env.COMMAND_CENTER_DB_ID || ids.commandCenter;
if (!ccId || ccId === 'pending-bootstrap') {
  console.error('[FAIL] COMMAND_CENTER_DB_ID required (env or .notion-db-ids.json).');
  process.exit(1);
}

// --- Observation window gate ------------------------------------------------
const logPath = '.planning/phases/01-infrastructure-foundation/vps-freeze-observation.log';
if (!existsSync(logPath)) {
  console.error(`[FAIL] Freeze observation log missing at ${logPath}. Run scripts/verify-vps-freeze.mjs first.`);
  process.exit(1);
}
const firstLine = readFileSync(logPath, 'utf8')
  .split('\n')
  .find((l) => l.includes('freeze-start'));
if (!firstLine) {
  console.error('[FAIL] No `freeze-start` entry in observation log.');
  process.exit(1);
}
const startIso = firstLine.split(' ')[0];
const startMs = new Date(startIso).getTime();
if (Number.isNaN(startMs)) {
  console.error(`[FAIL] Unparseable timestamp in observation log: "${startIso}"`);
  process.exit(1);
}

const WINDOW_MS = 48 * 60 * 60 * 1000;
const elapsedMs = Date.now() - startMs;
if (elapsedMs < WINDOW_MS) {
  const waitUntil = new Date(startMs + WINDOW_MS).toISOString();
  const hours = Math.floor(elapsedMs / 3600_000);
  console.error(
    `[FAIL] Freeze window <48h (elapsed ${hours}h). Wait until ${waitUntil} before re-running.`,
  );
  process.exit(1);
}

// --- Command Center zero-leak assertion over full 48h -----------------------
const since = new Date(Date.now() - WINDOW_MS).toISOString();
const r = await fetch(`https://api.notion.com/v1/databases/${ccId}/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    filter: { timestamp: 'created_time', created_time: { after: since } },
    page_size: 100,
  }),
});
if (!r.ok) {
  const text = await r.text();
  console.error(`[FAIL] Notion query failed ${r.status}: ${text}`);
  process.exit(1);
}
const j = await r.json();
const fromScripts = (j.results ?? []).filter((row) => {
  const serialised = JSON.stringify(row.properties ?? {});
  return (
    serialised.includes('classify_and_save') ||
    serialised.includes('morning_briefing') ||
    serialised.includes('evening_checkin')
  );
});

if (fromScripts.length > 0) {
  console.error(
    `[FAIL] Command Center received ${fromScripts.length} row(s) from patched scripts over 48h since ${since} — freeze BROKEN.`,
  );
  process.exit(2);
}

// eslint-disable-next-line no-console
console.log(`[OK] 48h observation clean: Command Center received ZERO rows from patched scripts since ${since}.`);
