#!/usr/bin/env node
/**
 * scripts/verify-morning-evening-retired.mjs — Phase 10 Plan 10-02 verifier.
 *
 * Operator-run AFTER `scripts/retire-vps-script.sh` has stopped the
 * legacy `morning_briefing` and `evening_checkin` Hetzner systemd units.
 * Confirms that Phase 7 AUTO-01 + AUTO-03 are healthy and the VPS-side
 * units are quiet — i.e. the retirement is real and the replacement is
 * working.
 *
 * Four checks (each runs independently; partial failures still report):
 *
 *   1. EventBridge Scheduler health
 *      `kos-morning-brief`  (CDK name: morning-brief-weekdays-08)
 *      `kos-day-close`      (CDK name: day-close-weekdays-18)
 *      Both must exist + State=ENABLED + ScheduleExpression matches the
 *      Phase 7 cron contract (see Phase 7 SUMMARY 07-01 / 07-02):
 *        morning-brief : cron(0 8 ? * MON-FRI *) Europe/Stockholm
 *        day-close     : cron(0 18 ? * MON-FRI *) Europe/Stockholm
 *      Schedule names are configurable via env (CDK auto-generates names
 *      including the stack id; the operator can override if the deploy
 *      does not match the defaults below).
 *
 *   2. CloudWatch Logs sanity
 *      Filter the Phase 7 Lambda log groups for any INFO line in the past
 *      48h (one weekend covers Mon-Fri schedules without a false-positive
 *      on a long weekend). Default log group prefixes:
 *        /aws/lambda/KosIntegrations-MorningBrief
 *        /aws/lambda/KosIntegrations-DayClose
 *      Pass MORNING_BRIEF_LOG_GROUP and DAY_CLOSE_LOG_GROUP if the actual
 *      stack id differs from the prefix above.
 *
 *   3. VPS systemd is-active
 *      ssh kevin@98.91.6.66 'systemctl is-active <unit>'
 *      Expected: 'inactive' for every entry in vps-service-inventory.json
 *      whose `unit_name` is morning_briefing.service or evening_checkin.service
 *      (or the matching Phase 1 freeze unit). Inventory is read from
 *      .planning/phases/10-migration-decommission/vps-service-inventory.json.
 *
 *   4. event_log audit trail
 *      psql -c "SELECT kind, detail->>'unit' AS unit FROM event_log
 *               WHERE kind='vps-service-stopped'
 *                 AND detail->>'unit' IN ('morning_briefing.service','evening_checkin.service')
 *               ORDER BY occurred_at DESC LIMIT 10"
 *      Expected: 2 rows minimum (one per unit). The retire-vps-script.sh
 *      tool writes BOTH 'vps-service-stopped' AND 'vps-service-disabled'
 *      kinds — this verifier only requires the 'stopped' row to be
 *      present (matches MIG-01 acceptance gate).
 *
 * Exit codes:
 *   0  all 4 checks PASS
 *   1  any check FAIL
 *   2  prerequisite (env vars / files / CLI tools) missing
 *
 * Usage:
 *   node scripts/verify-morning-evening-retired.mjs
 *   node scripts/verify-morning-evening-retired.mjs --skip-ssh   # CI-friendly
 *   node scripts/verify-morning-evening-retired.mjs --json       # machine output
 *   node scripts/verify-morning-evening-retired.mjs --help
 *
 * Required env (set by the operator before running):
 *   AWS_REGION                     default 'eu-north-1'
 *   RDS_URL                        psql DSN
 *   MORNING_BRIEF_SCHEDULE_NAME    default 'morning-brief-weekdays-08'
 *   DAY_CLOSE_SCHEDULE_NAME        default 'day-close-weekdays-18'
 *   SCHEDULE_GROUP_NAME            default 'kos-schedules'
 *   MORNING_BRIEF_LOG_GROUP        default '/aws/lambda/KosIntegrations-MorningBrief'
 *   DAY_CLOSE_LOG_GROUP            default '/aws/lambda/KosIntegrations-DayClose'
 *   VPS_SSH_TARGET                 default 'kevin@98.91.6.66'
 *
 * NPM dependencies (already in root package.json from Phase 1+):
 *   @aws-sdk/client-scheduler
 *   @aws-sdk/client-cloudwatch-logs
 *   pg
 *
 * NOTE: This script is intentionally read-only. It NEVER writes to RDS,
 * NEVER mutates schedules, NEVER restarts Lambdas. Pure verification.
 *
 * Cf. .planning/phases/10-migration-decommission/10-02-RETIREMENT-RUNBOOK.md
 *     for the T-0 + T+2h sequence that calls this script.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Argument parsing + help
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { skipSsh: false, json: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '--skip-ssh') out.skipSsh = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else {
      console.error(`[FAIL] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(
    [
      'Usage: node scripts/verify-morning-evening-retired.mjs [--skip-ssh] [--json]',
      '',
      'Verifies Phase 7 AUTO-01 + AUTO-03 are healthy AND the VPS legacy',
      'units (morning_briefing, evening_checkin) are systemd-inactive AND',
      'the event_log audit trail records the retirement.',
      '',
      'Exit 0 = all PASS, 1 = any FAIL, 2 = missing prerequisite.',
    ].join('\n'),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = {
  awsRegion: process.env.AWS_REGION || 'eu-north-1',
  rdsUrl: process.env.RDS_URL || '',
  morningScheduleName:
    process.env.MORNING_BRIEF_SCHEDULE_NAME || 'morning-brief-weekdays-08',
  dayCloseScheduleName:
    process.env.DAY_CLOSE_SCHEDULE_NAME || 'day-close-weekdays-18',
  scheduleGroupName: process.env.SCHEDULE_GROUP_NAME || 'kos-schedules',
  morningLogGroup:
    process.env.MORNING_BRIEF_LOG_GROUP ||
    '/aws/lambda/KosIntegrations-MorningBrief',
  dayCloseLogGroup:
    process.env.DAY_CLOSE_LOG_GROUP || '/aws/lambda/KosIntegrations-DayClose',
  vpsSshTarget: process.env.VPS_SSH_TARGET || 'kevin@98.91.6.66',
};

const INVENTORY_PATH = resolve(
  REPO_ROOT,
  '.planning/phases/10-migration-decommission/vps-service-inventory.json',
);
const FIXTURE_INVENTORY_PATH = resolve(
  REPO_ROOT,
  'packages/test-fixtures/phase-10/vps-service-inventory.json',
);

// ---------------------------------------------------------------------------
// Tiny ANSI colour helper (avoids a chalk dep — keeps the CI bundle small)
// ---------------------------------------------------------------------------

const isTty = process.stdout.isTTY && !args.json;
const c = {
  green: (s) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (isTty ? `\x1b[1m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// Check 1: EventBridge Scheduler health
// ---------------------------------------------------------------------------

async function checkSchedulers() {
  let SchedulerClient, GetScheduleCommand;
  try {
    ({ SchedulerClient, GetScheduleCommand } = await import(
      '@aws-sdk/client-scheduler'
    ));
  } catch (err) {
    return [
      {
        name: 'scheduler:morning-brief',
        ok: false,
        detail: `@aws-sdk/client-scheduler not installed: ${err.message}`,
      },
      {
        name: 'scheduler:day-close',
        ok: false,
        detail: '(skipped — sdk missing)',
      },
    ];
  }
  const client = new SchedulerClient({ region: cfg.awsRegion });

  const expected = [
    {
      key: 'kos-morning-brief',
      name: cfg.morningScheduleName,
      cron: 'cron(0 8 ? * MON-FRI *)',
    },
    {
      key: 'kos-day-close',
      name: cfg.dayCloseScheduleName,
      cron: 'cron(0 18 ? * MON-FRI *)',
    },
  ];

  const out = [];
  for (const e of expected) {
    try {
      const res = await client.send(
        new GetScheduleCommand({
          Name: e.name,
          GroupName: cfg.scheduleGroupName,
        }),
      );
      const stateOk = res.State === 'ENABLED';
      const cronOk = (res.ScheduleExpression || '').replace(/\s+/g, ' ') === e.cron;
      const tzOk = res.ScheduleExpressionTimezone === 'Europe/Stockholm';
      const ok = stateOk && cronOk && tzOk;
      out.push({
        name: `scheduler:${e.key}`,
        ok,
        detail:
          `state=${res.State} cron=${res.ScheduleExpression} tz=${res.ScheduleExpressionTimezone}` +
          (ok ? '' : ` (expected: ENABLED, ${e.cron}, Europe/Stockholm)`),
      });
    } catch (err) {
      out.push({
        name: `scheduler:${e.key}`,
        ok: false,
        detail: `GetSchedule failed: ${err.name || ''} ${err.message}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 2: CloudWatch Logs — recent invocation
// ---------------------------------------------------------------------------

async function checkRecentLogs() {
  let CloudWatchLogsClient, FilterLogEventsCommand;
  try {
    ({ CloudWatchLogsClient, FilterLogEventsCommand } = await import(
      '@aws-sdk/client-cloudwatch-logs'
    ));
  } catch (err) {
    return [
      {
        name: 'logs:morning-brief',
        ok: false,
        detail: `@aws-sdk/client-cloudwatch-logs not installed: ${err.message}`,
      },
      { name: 'logs:day-close', ok: false, detail: '(skipped — sdk missing)' },
    ];
  }
  const client = new CloudWatchLogsClient({ region: cfg.awsRegion });
  const now = Date.now();
  const fortyEightHoursAgo = now - 48 * 3600 * 1000;

  const groups = [
    { key: 'morning-brief', logGroup: cfg.morningLogGroup },
    { key: 'day-close', logGroup: cfg.dayCloseLogGroup },
  ];
  const out = [];
  for (const g of groups) {
    try {
      const res = await client.send(
        new FilterLogEventsCommand({
          logGroupName: g.logGroup,
          startTime: fortyEightHoursAgo,
          endTime: now,
          limit: 5,
        }),
      );
      const count = (res.events || []).length;
      out.push({
        name: `logs:${g.key}`,
        ok: count > 0,
        detail: `${count} events in past 48h in ${g.logGroup}`,
      });
    } catch (err) {
      // Common case: log group does not exist by exact name (CDK auto-suffix).
      // Surface the prefix-mismatch as a hint, not a hard PASS.
      out.push({
        name: `logs:${g.key}`,
        ok: false,
        detail: `FilterLogEvents failed (${err.name || ''}): ${err.message}. Set ${g.key === 'morning-brief' ? 'MORNING_BRIEF_LOG_GROUP' : 'DAY_CLOSE_LOG_GROUP'} env if log group name differs.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 3: VPS systemd is-active
// ---------------------------------------------------------------------------

function loadInventory() {
  // Real inventory wins; fixture is the test/scaffold fallback.
  if (existsSync(INVENTORY_PATH)) {
    return JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  }
  if (existsSync(FIXTURE_INVENTORY_PATH)) {
    return JSON.parse(readFileSync(FIXTURE_INVENTORY_PATH, 'utf8'));
  }
  return null;
}

function checkVpsSystemd(skipSsh) {
  const inv = loadInventory();
  if (!inv || !Array.isArray(inv.services)) {
    return [
      {
        name: 'systemd:inventory',
        ok: false,
        detail: `vps-service-inventory.json not found at ${INVENTORY_PATH} or fixture; run scripts/discover-vps-scripts.sh first`,
      },
    ];
  }
  // Filter to only morning + evening units (this plan's scope).
  const targets = inv.services.filter((s) => {
    const u = (s.unit_name || '').toLowerCase();
    return (
      u.startsWith('morning_briefing') ||
      u.startsWith('morning-briefing') ||
      u.startsWith('evening_checkin') ||
      u.startsWith('evening-checkin')
    );
  });

  if (targets.length === 0) {
    return [
      {
        name: 'systemd:inventory-match',
        ok: false,
        detail: 'no morning_briefing or evening_checkin entries in inventory',
      },
    ];
  }

  if (skipSsh) {
    return targets.map((t) => ({
      name: `systemd:${t.unit_name}`,
      ok: t.state === 'inactive' || t.state === 'failed',
      detail: `inventory state=${t.state} (--skip-ssh: not re-checked over SSH)`,
    }));
  }

  return targets.map((t) => {
    const r = spawnSync(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'BatchMode=yes',
        cfg.vpsSshTarget,
        `systemctl is-active ${t.unit_name} || true`,
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    const liveState = (r.stdout || '').trim() || `(ssh-error: ${r.stderr?.trim() || 'unknown'})`;
    const ok = liveState === 'inactive' || liveState === 'failed' || liveState === 'unknown';
    return {
      name: `systemd:${t.unit_name}`,
      ok,
      detail: `live state=${liveState} (expected inactive)`,
    };
  });
}

// ---------------------------------------------------------------------------
// Check 4: event_log audit trail
// ---------------------------------------------------------------------------

async function checkEventLog() {
  if (!cfg.rdsUrl) {
    return [
      {
        name: 'event_log:audit-rows',
        ok: false,
        detail: 'RDS_URL env var not set — cannot query event_log',
      },
    ];
  }
  let pgMod;
  try {
    pgMod = await import('pg');
  } catch (err) {
    return [
      {
        name: 'event_log:audit-rows',
        ok: false,
        detail: `pg module not installed: ${err.message}`,
      },
    ];
  }
  const { Client } = pgMod.default || pgMod;
  const client = new Client({ connectionString: cfg.rdsUrl });
  try {
    await client.connect();
    const sql = `
      SELECT kind, detail->>'unit' AS unit, occurred_at
      FROM event_log
      WHERE kind = 'vps-service-stopped'
        AND detail->>'unit' IN (
          'morning_briefing.service',
          'evening_checkin.service',
          'morning_briefing',
          'evening_checkin'
        )
      ORDER BY occurred_at DESC
      LIMIT 10
    `;
    const res = await client.query(sql);
    const units = new Set(res.rows.map((r) => (r.unit || '').replace(/\.service$/, '')));
    const haveMorning = units.has('morning_briefing');
    const haveEvening = units.has('evening_checkin');
    const ok = haveMorning && haveEvening;
    return [
      {
        name: 'event_log:audit-rows',
        ok,
        detail: `morning_briefing=${haveMorning ? 'present' : 'MISSING'} evening_checkin=${haveEvening ? 'present' : 'MISSING'} (rows=${res.rows.length})`,
      },
    ];
  } catch (err) {
    return [
      {
        name: 'event_log:audit-rows',
        ok: false,
        detail: `psql query failed: ${err.message}`,
      },
    ];
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const all = [];
  all.push(...(await checkSchedulers()));
  all.push(...(await checkRecentLogs()));
  all.push(...checkVpsSystemd(args.skipSsh));
  all.push(...(await checkEventLog()));

  const passed = all.filter((r) => r.ok).length;
  const failed = all.length - passed;

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ passed, failed, results: all }, null, 2) + '\n',
    );
  } else {
    console.log(c.bold('Phase 10 Plan 10-02 — morning/evening retirement verifier'));
    console.log('');
    for (const r of all) {
      const tag = r.ok ? c.green('PASS') : c.red('FAIL');
      console.log(`  ${tag}  ${r.name.padEnd(36)}  ${r.detail}`);
    }
    console.log('');
    console.log(
      c.bold(`Summary: ${passed}/${all.length} PASS  (${failed} failed)`),
    );
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(`[FAIL] verifier crashed: ${err.stack || err.message}`));
  process.exit(1);
});
