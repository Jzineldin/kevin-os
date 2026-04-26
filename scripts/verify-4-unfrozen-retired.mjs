#!/usr/bin/env node
/**
 * scripts/verify-4-unfrozen-retired.mjs — Phase 10 Plan 10-06 verifier.
 *
 * Operator-run AFTER `scripts/retire-vps-script.sh` has stopped + disabled +
 * masked the four UNFROZEN VPS systemd units that Plan 10-06 retires:
 *
 *   1. brain_server          → INERT (Phase 3 dashboard supersedes; the
 *                              dashboard-listen-relay Fargate task + the
 *                              relay-proxy Lambda + the Vercel-hosted
 *                              Next.js dashboard collectively replace the
 *                              hand-rolled Hetzner web frontend.)
 *   2. gmail_classifier      → REPLACED by Phase 4 email-triage Lambda
 *                              (AGT-05; CDK construct `EmailTriageAgent`
 *                              under stack `KosIntegrations`).
 *   3. brain-dump-listener   → REPLACED by Phase 5 + Plan 10-04 Discord
 *                              brain-dump Lambda (CAP-10; CDK construct
 *                              `DiscordBrainDump` under stack
 *                              `KosMigration`). Hard prereq: 7-day
 *                              same-substance PASS in
 *                              scripts/verify-discord-brain-dump-substance.mjs.
 *   4. sync_aggregated       → INERT (no replacement; aggregation handled
 *                              by KOS triage + agents).
 *
 * Five check classes (each runs independently; partial failures still
 * report — the script exits non-zero if any single check FAILs):
 *
 *   A. systemctl is-active   over SSH per unit  → expect 'inactive'
 *   B. systemctl is-enabled  over SSH per unit  → expect 'masked' OR 'disabled'
 *   C. ps aux | grep         over SSH per unit  → expect zero matches
 *   D. event_log audit row   in RDS  → expect ≥ 1 'vps-service-stopped'
 *                              row per service_name in the past 30 days
 *   E. replacement liveness  per retired script:
 *        - brain_server          → relay-proxy Lambda exists (Phase 3 dashboard relay)
 *        - gmail_classifier      → email-triage Lambda exists + has logs ≤ 48h
 *        - brain-dump-listener   → DiscordBrainDump Lambda exists + has logs ≤ 48h
 *        - sync_aggregated       → no replacement; only audit row required (D)
 *
 * Exit codes:
 *   0  all checks PASS
 *   1  any check FAIL
 *   2  prerequisite (env vars / files / CLI tools) missing
 *
 * Usage:
 *   node scripts/verify-4-unfrozen-retired.mjs
 *   node scripts/verify-4-unfrozen-retired.mjs --skip-ssh   # CI-friendly
 *   node scripts/verify-4-unfrozen-retired.mjs --json       # machine output
 *   node scripts/verify-4-unfrozen-retired.mjs --help
 *
 * Required env (set by the operator before running):
 *   AWS_REGION                            default 'eu-north-1'
 *   RDS_URL                               psql DSN
 *   VPS_SSH_TARGET                        default 'kevin@98.91.6.66'
 *   BRAIN_SERVER_UNIT                     default 'brain-server.service'
 *   GMAIL_CLASSIFIER_UNIT                 default 'gmail-classifier.service'
 *   BRAIN_DUMP_LISTENER_UNIT              default 'brain-dump-listener.service'
 *   SYNC_AGGREGATED_UNIT                  default 'sync-aggregated.service'
 *   RELAY_PROXY_FUNCTION_NAME             default 'KosIntegrations-RelayProxy'
 *   EMAIL_TRIAGE_FUNCTION_NAME            default 'KosIntegrations-EmailTriageAgent'
 *   DISCORD_BRAIN_DUMP_FUNCTION_NAME      default 'KosMigration-DiscordBrainDump'
 *   RELAY_PROXY_LOG_GROUP                 default '/aws/lambda/' + RELAY_PROXY_FUNCTION_NAME
 *   EMAIL_TRIAGE_LOG_GROUP                default '/aws/lambda/' + EMAIL_TRIAGE_FUNCTION_NAME
 *   DISCORD_BRAIN_DUMP_LOG_GROUP          default '/aws/lambda/' + DISCORD_BRAIN_DUMP_FUNCTION_NAME
 *
 * NPM dependencies (root package.json):
 *   @aws-sdk/client-cloudwatch-logs     ✓ at root
 *   @aws-sdk/client-lambda              ✓ at root
 *   pg                                  ✓ at root
 *
 * NOTE: This script is intentionally read-only. It NEVER writes to RDS,
 * NEVER mutates Lambdas, NEVER restarts services. Pure verification.
 *
 * Cf. .planning/phases/10-migration-decommission/10-06-RETIREMENT-RUNBOOK.md
 *     for the operator T-0 sequence that calls this script.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

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
      'Usage: node scripts/verify-4-unfrozen-retired.mjs [--skip-ssh] [--json]',
      '',
      'Verifies the four UNFROZEN VPS scripts retired by Plan 10-06 are',
      'systemctl-inactive + disabled/masked AND that their replacements',
      '(Phase 3 dashboard relay, Phase 4 email-triage, Phase 5/10 Discord',
      'brain-dump Lambda) are live AND that the event_log audit trail',
      'records the retirement.',
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
  vpsSshTarget: process.env.VPS_SSH_TARGET || 'kevin@98.91.6.66',

  brainServerUnit: process.env.BRAIN_SERVER_UNIT || 'brain-server.service',
  gmailClassifierUnit:
    process.env.GMAIL_CLASSIFIER_UNIT || 'gmail-classifier.service',
  brainDumpListenerUnit:
    process.env.BRAIN_DUMP_LISTENER_UNIT || 'brain-dump-listener.service',
  syncAggregatedUnit:
    process.env.SYNC_AGGREGATED_UNIT || 'sync-aggregated.service',

  relayProxyFnName:
    process.env.RELAY_PROXY_FUNCTION_NAME || 'KosIntegrations-RelayProxy',
  emailTriageFnName:
    process.env.EMAIL_TRIAGE_FUNCTION_NAME ||
    'KosIntegrations-EmailTriageAgent',
  discordBrainDumpFnName:
    process.env.DISCORD_BRAIN_DUMP_FUNCTION_NAME ||
    'KosMigration-DiscordBrainDump',
};
cfg.relayProxyLogGroup =
  process.env.RELAY_PROXY_LOG_GROUP || `/aws/lambda/${cfg.relayProxyFnName}`;
cfg.emailTriageLogGroup =
  process.env.EMAIL_TRIAGE_LOG_GROUP || `/aws/lambda/${cfg.emailTriageFnName}`;
cfg.discordBrainDumpLogGroup =
  process.env.DISCORD_BRAIN_DUMP_LOG_GROUP ||
  `/aws/lambda/${cfg.discordBrainDumpFnName}`;

// service_name keys used in event_log.detail (matches retire-vps-script.sh
// detail JSON via either 'service_name' OR 'unit' field — we accept both).
const RETIRED = [
  {
    serviceName: 'brain_server',
    unit: cfg.brainServerUnit,
    processGrep: 'brain_server',
    replacement: {
      kind: 'lambda',
      label: 'Phase 3 dashboard relay (RelayProxy)',
      functionName: cfg.relayProxyFnName,
      logGroup: cfg.relayProxyLogGroup,
      requireRecentLogs: false, // relay-proxy is request-driven, no scheduled invocations
    },
  },
  {
    serviceName: 'gmail_classifier',
    unit: cfg.gmailClassifierUnit,
    processGrep: 'gmail_classifier',
    replacement: {
      kind: 'lambda',
      label: 'Phase 4 email-triage (EmailTriageAgent)',
      functionName: cfg.emailTriageFnName,
      logGroup: cfg.emailTriageLogGroup,
      requireRecentLogs: true, // 2h schedule → 48h window has multiple invocations
    },
  },
  {
    serviceName: 'brain-dump-listener',
    unit: cfg.brainDumpListenerUnit,
    processGrep: 'brain-dump-listener',
    replacement: {
      kind: 'lambda',
      label: 'Phase 5 + 10-04 Discord brain-dump Lambda (DiscordBrainDump)',
      functionName: cfg.discordBrainDumpFnName,
      logGroup: cfg.discordBrainDumpLogGroup,
      requireRecentLogs: true, // 5min schedule → guaranteed recent logs
    },
  },
  {
    serviceName: 'sync_aggregated',
    unit: cfg.syncAggregatedUnit,
    processGrep: 'sync_aggregated',
    replacement: null, // INERT — no replacement, only audit row required
  },
];

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
// SSH helper
// ---------------------------------------------------------------------------

function sshRun(remoteCmd, timeoutMs = 15000) {
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
      remoteCmd,
    ],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  return {
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    status: r.status,
    error: r.error?.message,
  };
}

// ---------------------------------------------------------------------------
// Check A: systemctl is-active per unit
// ---------------------------------------------------------------------------

function checkSystemctlActive(skipSsh) {
  return RETIRED.map((r) => {
    if (skipSsh) {
      return {
        name: `systemctl-active:${r.serviceName}`,
        ok: true,
        detail: `(--skip-ssh: not re-checked over SSH for ${r.unit})`,
      };
    }
    // `|| true` so a non-zero exit (= not-found / inactive) does not abort.
    const res = sshRun(`systemctl is-active ${r.unit} || true`);
    const state = res.stdout || `(ssh-error: ${res.stderr || res.error || 'unknown'})`;
    // Acceptable states for a retired unit: inactive, failed, unknown
    // (a `mask`ed unit reports `inactive`).
    const ok = state === 'inactive' || state === 'failed' || state === 'unknown';
    return {
      name: `systemctl-active:${r.serviceName}`,
      ok,
      detail: `unit=${r.unit} live state=${state} (expected inactive/failed/unknown)`,
    };
  });
}

// ---------------------------------------------------------------------------
// Check B: systemctl is-enabled per unit
// ---------------------------------------------------------------------------

function checkSystemctlEnabled(skipSsh) {
  return RETIRED.map((r) => {
    if (skipSsh) {
      return {
        name: `systemctl-enabled:${r.serviceName}`,
        ok: true,
        detail: `(--skip-ssh: not re-checked over SSH for ${r.unit})`,
      };
    }
    const res = sshRun(`systemctl is-enabled ${r.unit} || true`);
    const state = res.stdout || `(ssh-error: ${res.stderr || res.error || 'unknown'})`;
    // Plan 10-06 acceptance: unit must be either `masked` (preferred —
    // retire-vps-script.sh applies mask) OR `disabled` (acceptable
    // intermediate state). `static`, `enabled`, `alias` all FAIL.
    const ok = state === 'masked' || state === 'disabled';
    return {
      name: `systemctl-enabled:${r.serviceName}`,
      ok,
      detail: `unit=${r.unit} live state=${state} (expected masked or disabled)`,
    };
  });
}

// ---------------------------------------------------------------------------
// Check C: ps aux | grep over SSH per unit (zero residual processes)
// ---------------------------------------------------------------------------

function checkNoResidualProcess(skipSsh) {
  return RETIRED.map((r) => {
    if (skipSsh) {
      return {
        name: `ps-clean:${r.serviceName}`,
        ok: true,
        detail: `(--skip-ssh: not re-checked over SSH for ${r.processGrep})`,
      };
    }
    // Match the process pattern but exclude the grep itself. `|| true` so
    // a no-match exit code (1) does not abort.
    const cmd = `ps aux | grep -F "${r.processGrep}" | grep -v grep | grep -v retire-vps-script || true`;
    const res = sshRun(cmd);
    const lines = res.stdout ? res.stdout.split('\n').filter(Boolean) : [];
    const ok = lines.length === 0;
    return {
      name: `ps-clean:${r.serviceName}`,
      ok,
      detail: `${lines.length} residual process(es) matching '${r.processGrep}' (expected 0)`,
    };
  });
}

// ---------------------------------------------------------------------------
// Check D: event_log audit row per service in past 30 days
// ---------------------------------------------------------------------------

async function checkEventLog() {
  if (!cfg.rdsUrl) {
    return RETIRED.map((r) => ({
      name: `event_log:${r.serviceName}`,
      ok: false,
      detail: 'RDS_URL env var not set — cannot query event_log',
    }));
  }
  let pgMod;
  try {
    pgMod = await import('pg');
  } catch (err) {
    return RETIRED.map((r) => ({
      name: `event_log:${r.serviceName}`,
      ok: false,
      detail: `pg module not installed: ${err.message}`,
    }));
  }
  const { Client } = pgMod.default || pgMod;
  const client = new Client({ connectionString: cfg.rdsUrl });
  const out = [];
  try {
    await client.connect();
    for (const r of RETIRED) {
      // retire-vps-script.sh writes detail.unit (e.g. 'brain-server.service').
      // Operator-run discovery may instead populate detail.service_name
      // (e.g. 'brain_server'). We accept either, AND we strip a trailing
      // '.service' suffix on the unit field before comparing.
      //
      // The query also tolerates underscored vs hyphenated service_name
      // (gmail_classifier vs gmail-classifier — both used in inventory).
      const sql = `
        SELECT count(*)::int AS n
        FROM event_log
        WHERE kind = 'vps-service-stopped'
          AND (
            details->>'service_name' = $1
            OR details->>'service_name' = $2
            OR details->>'unit'         = $3
            OR details->>'unit'         = $4
            OR replace(details->>'unit', '.service', '') = $1
            OR replace(details->>'unit', '.service', '') = $2
          )
          AND COALESCE(at, occurred_at) > now() - interval '30 days'
      `;
      const altName = r.serviceName.replace(/_/g, '-');
      const altName2 = r.serviceName.replace(/-/g, '_');
      const params = [
        r.serviceName, // 'brain_server'
        altName === r.serviceName ? altName2 : altName, // 'brain-server' (or vice versa)
        r.unit, // 'brain-server.service'
        r.unit.replace(/\.service$/, ''), // 'brain-server'
      ];
      try {
        const res = await client.query(sql, params);
        const n = res.rows?.[0]?.n ?? 0;
        out.push({
          name: `event_log:${r.serviceName}`,
          ok: n >= 1,
          detail: `${n} 'vps-service-stopped' row(s) in past 30d for ${r.serviceName} (expected ≥ 1)`,
        });
      } catch (err) {
        out.push({
          name: `event_log:${r.serviceName}`,
          ok: false,
          detail: `psql query failed: ${err.message}`,
        });
      }
    }
  } catch (err) {
    return RETIRED.map((r) => ({
      name: `event_log:${r.serviceName}`,
      ok: false,
      detail: `psql connect failed: ${err.message}`,
    }));
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check E: replacement liveness — Lambda exists + (optional) recent logs
// ---------------------------------------------------------------------------

async function checkReplacements() {
  let LambdaClient, GetFunctionCommand;
  let CloudWatchLogsClient, FilterLogEventsCommand;

  try {
    ({ LambdaClient, GetFunctionCommand } = await import(
      '@aws-sdk/client-lambda'
    ));
  } catch (err) {
    return RETIRED.filter((r) => r.replacement).map((r) => ({
      name: `replacement:${r.serviceName}`,
      ok: false,
      detail: `@aws-sdk/client-lambda not installed: ${err.message}`,
    }));
  }
  try {
    ({ CloudWatchLogsClient, FilterLogEventsCommand } = await import(
      '@aws-sdk/client-cloudwatch-logs'
    ));
  } catch (err) {
    // Soft-fail logs — fall back to lambda-only existence.
    CloudWatchLogsClient = null;
  }

  const lambdaClient = new LambdaClient({ region: cfg.awsRegion });
  const logsClient = CloudWatchLogsClient
    ? new CloudWatchLogsClient({ region: cfg.awsRegion })
    : null;

  const out = [];
  for (const r of RETIRED) {
    if (!r.replacement) {
      // sync_aggregated — no replacement; D-13 audit row is the only signal.
      out.push({
        name: `replacement:${r.serviceName}`,
        ok: true,
        detail: 'INERT (no replacement; audit-row-only — see Check D)',
      });
      continue;
    }

    // Sub-check E1: Lambda function exists + state == Active
    let lambdaOk = false;
    let lambdaDetail = '';
    try {
      const res = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: r.replacement.functionName }),
      );
      const state = res.Configuration?.State;
      lambdaOk = state === 'Active';
      lambdaDetail = `Lambda ${r.replacement.functionName} State=${state || 'UNKNOWN'}`;
    } catch (err) {
      lambdaOk = false;
      lambdaDetail = `GetFunction failed for ${r.replacement.functionName}: ${err.name || ''} ${err.message}`;
    }

    // Sub-check E2 (only if requireRecentLogs): CloudWatch logs ≤ 48h
    let logsOk = true;
    let logsDetail = '(recent-log check skipped)';
    if (r.replacement.requireRecentLogs && logsClient) {
      try {
        const now = Date.now();
        const fortyEightHoursAgo = now - 48 * 3600 * 1000;
        const lr = await logsClient.send(
          new FilterLogEventsCommand({
            logGroupName: r.replacement.logGroup,
            startTime: fortyEightHoursAgo,
            endTime: now,
            limit: 5,
          }),
        );
        const count = (lr.events || []).length;
        logsOk = count > 0;
        logsDetail = `${count} log event(s) in past 48h in ${r.replacement.logGroup}`;
      } catch (err) {
        logsOk = false;
        logsDetail = `FilterLogEvents failed (${err.name || ''}): ${err.message}. Set ${r.serviceName.toUpperCase().replace(/-/g, '_')}_LOG_GROUP env if name differs.`;
      }
    } else if (r.replacement.requireRecentLogs && !logsClient) {
      logsOk = false;
      logsDetail = '@aws-sdk/client-cloudwatch-logs not installed; cannot verify recent logs';
    }

    out.push({
      name: `replacement:${r.serviceName}`,
      ok: lambdaOk && logsOk,
      detail: `${r.replacement.label} — ${lambdaDetail}; ${logsDetail}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const all = [];
  all.push(...checkSystemctlActive(args.skipSsh));
  all.push(...checkSystemctlEnabled(args.skipSsh));
  all.push(...checkNoResidualProcess(args.skipSsh));
  all.push(...(await checkEventLog()));
  all.push(...(await checkReplacements()));

  const passed = all.filter((r) => r.ok).length;
  const failed = all.length - passed;

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ passed, failed, results: all }, null, 2) + '\n',
    );
  } else {
    console.log(
      c.bold('Phase 10 Plan 10-06 — 4-unfrozen VPS scripts retirement verifier'),
    );
    console.log('');
    for (const r of all) {
      const tag = r.ok ? c.green('PASS') : c.red('FAIL');
      console.log(`  ${tag}  ${r.name.padEnd(40)}  ${r.detail}`);
    }
    console.log('');
    if (failed === 0) {
      console.log(c.bold(c.green(`[OK] 4/4 unfrozen VPS scripts retired (${passed}/${all.length} checks PASS)`)));
    } else {
      console.log(
        c.bold(
          c.red(`Summary: ${passed}/${all.length} PASS  (${failed} FAILED)`),
        ),
      );
      console.log(
        c.yellow(
          'See .planning/phases/10-migration-decommission/10-06-RETIREMENT-RUNBOOK.md for the rollback procedure.',
        ),
      );
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(`[FAIL] verifier crashed: ${err.stack || err.message}`));
  process.exit(1);
});
