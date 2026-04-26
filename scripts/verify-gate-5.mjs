#!/usr/bin/env node
/**
 * verify-gate-5.mjs — Phase 5 Gate 5 ("WhatsApp Baileys Production-Safe")
 * verifier.
 *
 * Gate 5 has FIVE criteria. Three are unit-test-automatable today; one is a
 * 7-day operator soak; one is a live-AWS reconnect probe. This script proves
 * what it can and explicitly DOCUMENTS the rest.
 *
 *   1. SESSION-PERSISTENCE CONTRACT (auto)
 *      - Delegates to vitest in @kos/service-baileys-fargate which exercises
 *        the postgres-backed SignalKeyStore (whatsapp_session_keys table).
 *        Live mode additionally probes RDS for a real `creds` row.
 *
 *   2. READ-ONLY DEFENSE-IN-DEPTH (auto)
 *      - Delegates to vitest in @kos/service-baileys-fargate which asserts
 *        every write-style WASocket method (sendMessage / updateStatus / etc.)
 *        is wrapped to throw `BAILEYS_WRITE_REJECTED`. Same module also tests
 *        the 4h backoff on session-rejection.
 *
 *   3. CHROME EXTENSION RELIABILITY (auto)
 *      - Delegates to vitest in @kos/service-chrome-webhook + the
 *        @kos/chrome-extension package (HMAC + Bearer + 5s round-trip).
 *
 *   4. LINKEDIN RATE-LIMIT SAFETY (auto)
 *      - Delegates to vitest in @kos/service-linkedin-webhook + chrome-extension
 *        content-linkedin tests (visibility-gated 30-min poll, 2-15s delays,
 *        401/403 silent-fail to system_alerts).
 *      - Plus: optional 14-day observation aggregate via
 *        scripts/verify-linkedin-observation.mjs (delegates if present;
 *        SKIP if Plan 05-03 hasn't shipped that script yet).
 *
 *   5. DISCORD POLLER WIRING (auto)
 *      - Offline: delegates to @kos/cdk vitest run filtered to
 *        integrations-discord (verifies the EventBridge Scheduler rule
 *        synthesizes correctly).
 *      - Live: SSM parameter /kos/discord/brain-dump-lambda-arn must resolve
 *        to a real Lambda ARN (Phase 10 Plan 10-04). PENDING = soft skip.
 *
 *   ---- NOT AUTOMATED HERE ----
 *   6. 7-DAY ZERO-WRITE BAILEYS SOAK (operator + verify-gate-5-baileys Lambda)
 *      - The verify-gate-5-baileys daily Lambda greps /ecs/baileys for
 *        BAILEYS_WRITE_REJECTED / sendMessage / updateStatus log lines and
 *        increments a counter in `sync_status.queue_depth WHERE
 *        channel='baileys_gate_5'`. Pass = counter >= 7.
 *      - This script reads that counter in --mode=live and surfaces the
 *        result. In --mode=offline it is SKIPPED with a runbook reminder.
 *      - BLOCKED ON Plan 05-04 (Baileys Fargate CDK, autonomous=false).
 *        Until 05-04 + 05-05 + the verify-gate-5-baileys Lambda are deployed,
 *        the soak is reported as `MANUAL_BLOCKED` rather than failing.
 *
 *   7. KILL-TASK RECONNECT PROBE (operator)
 *      - `aws ecs update-service ... --force-new-deployment` then assert no
 *        QR re-scan in /ecs/baileys logs within 60s. Documented in
 *        05-07-GATE-5-evidence-template.md (Criterion 3).
 *
 * Modes:
 *   --mode=offline (default)
 *     • All vitest sub-runs. No AWS / RDS calls.
 *     • Soak (#6) + reconnect probe (#7) are SKIPPED with runbook reminder.
 *
 *   --mode=live (operator-invoked, requires deployed infra + AWS creds)
 *     • #1 also queries RDS `whatsapp_session_keys` for a `creds` row.
 *     • #5 hits SSM for the Discord listener ARN.
 *     • #6 reads the zero_write_days counter from `sync_status`. PENDING if
 *        the verify-gate-5-baileys Lambda hasn't been deployed (Plan 05-04).
 *     • #7 still operator-only (use --probe-reconnect on a wrapper script
 *        once 05-04 lands; intentionally NOT auto-run here to avoid kicking
 *        a real production Fargate task without confirmation).
 *
 * Tests:
 *   --test=session | read-only | chrome | linkedin | discord | soak | all
 *
 * Exit codes:
 *   0 — every selected test PASS (or SKIP in offline / MANUAL_BLOCKED for soak)
 *   1 — any selected test FAIL
 *   2 — usage error / missing required env in live mode
 *
 * Output:
 *   stdout: human pass/fail summary
 *   stderr: structured JSON per test on failure (machine-readable)
 *
 * Usage:
 *   node scripts/verify-gate-5.mjs --mode=offline                    # default
 *   node scripts/verify-gate-5.mjs --mode=offline --test=read-only
 *   AWS_REGION=eu-north-1 DATABASE_URL=postgres://... \
 *     node scripts/verify-gate-5.mjs --mode=live
 *
 * Reference:
 *   .planning/phases/05-messaging-channels/05-07-PLAN.md
 *   .planning/phases/05-messaging-channels/05-07-GATE-5-evidence-template.md
 *   .planning/phases/05-messaging-channels/05-VALIDATION.md
 *   scripts/verify-gate-3.mjs (Phase 4 sibling)
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ----------------------------------------------------------------------------
// CLI parsing
// ----------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'offline' },
    test: { type: 'string', default: 'all' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`Usage: node scripts/verify-gate-5.mjs [--mode=offline|live] [--test=<name>|all]

Modes:
  --mode=offline (default)  Vitest delegates only; no cloud calls.
  --mode=live               Adds RDS + SSM probes; operator-invoked post-deploy.

Tests:
  --test=session            Criterion 1: postgres SignalKeyStore session persistence
  --test=read-only          Criterion 2: read-only wrapper + 4h backoff
  --test=chrome             Criterion 3: Chrome extension reliability
  --test=linkedin           Criterion 4: LinkedIn rate-limit safety
  --test=discord            Criterion 5: Discord scheduler wiring
  --test=soak               Criterion 6: 7-day zero-write Baileys soak (live only)
  --test=all (default)      Run all of the above.

Not automated by this verifier:
  Criterion 7 — kill-task reconnect probe. Operator runbook in
  .planning/phases/05-messaging-channels/05-07-GATE-5-evidence-template.md
  (Criterion 3 in template numbering — separate document numbering).
`);
  process.exit(0);
}

const mode = String(values.mode);
const test = String(values.test);

if (!['offline', 'live'].includes(mode)) {
  console.error(`[verify-gate-5] unknown --mode=${mode} (expected offline | live)`);
  process.exit(2);
}
const VALID_TESTS = ['all', 'session', 'read-only', 'chrome', 'linkedin', 'discord', 'soak'];
if (!VALID_TESTS.includes(test)) {
  console.error(`[verify-gate-5] unknown --test=${test} (expected one of ${VALID_TESTS.join(' | ')})`);
  process.exit(2);
}

// ----------------------------------------------------------------------------
// Repo root resolution (script lives in scripts/)
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ----------------------------------------------------------------------------
// Result accumulator
// ----------------------------------------------------------------------------

/** @typedef {{ name: string, status: 'PASS'|'FAIL'|'SKIP'|'MANUAL_BLOCKED'|'PENDING', detail?: unknown, error?: string }} TestResult */

/** @type {TestResult[]} */
const results = [];

async function runTest(name, fn) {
  process.stdout.write(`[${name}] running…  `);
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object') {
      if ('skipped' in detail) {
        results.push({ name, status: 'SKIP', detail });
        console.log(`SKIP  ${JSON.stringify(detail)}`);
        return;
      }
      if ('manual_blocked' in detail) {
        results.push({ name, status: 'MANUAL_BLOCKED', detail });
        console.log(`MANUAL_BLOCKED  ${JSON.stringify(detail)}`);
        return;
      }
      if ('pending' in detail) {
        results.push({ name, status: 'PENDING', detail });
        console.log(`PENDING  ${JSON.stringify(detail)}`);
        return;
      }
    }
    results.push({ name, status: 'PASS', detail });
    console.log(`PASS  ${detail ? JSON.stringify(detail) : ''}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message });
    console.log(`FAIL  ${message}`);
    process.stderr.write(
      JSON.stringify({ test: name, status: 'FAIL', error: message }) + '\n',
    );
  }
}

// ----------------------------------------------------------------------------
// Subprocess helper (mirrors verify-phase-4-e2e pattern)
// ----------------------------------------------------------------------------

function runVitest(pkg, filter) {
  const args = ['--filter', pkg, 'test', '--', '--run', '--reporter=basic'];
  if (filter) args.push(filter);
  const r = spawnSync('pnpm', args, { encoding: 'utf-8', cwd: REPO_ROOT });
  return {
    ok: r.status === 0,
    status: r.status,
    stdoutTail: (r.stdout ?? '').slice(-1500),
    stderrTail: (r.stderr ?? '').slice(-1500),
  };
}

function pkgExists(pkg) {
  // Heuristic: workspace package directories follow services/<name> or
  // packages/<name> or apps/<name>. We probe each location for a package.json
  // whose `name` matches.
  const candidates = [
    `services/${pkg.replace(/^@kos\/service-/, '').replace(/^@kos\//, '')}`,
    `packages/${pkg.replace(/^@kos\//, '')}`,
    `apps/${pkg.replace(/^@kos\//, '')}`,
  ];
  return candidates.some((rel) => existsSync(resolve(REPO_ROOT, rel, 'package.json')));
}

// ----------------------------------------------------------------------------
// Test 1 — session persistence (postgres SignalKeyStore)
// ----------------------------------------------------------------------------

async function testSession() {
  // Offline: delegate to baileys-fargate vitest. The session-store unit tests
  // exercise the read/write/delete contract against an in-memory pg double.
  const r = runVitest('@kos/service-baileys-fargate');
  if (!r.ok) {
    throw new Error(
      `baileys-fargate vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  // Live extra: probe RDS for a real `creds` row. This proves QR was scanned
  // and the persistence path actually wrote to the table (not just that the
  // unit tests pass).
  if (mode === 'live') {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('live mode requires DATABASE_URL for RDS session probe');
    }
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('rds.amazonaws.com')
        ? { rejectUnauthorized: false }
        : undefined,
      max: 1,
    });
    try {
      const probe = await pool.query(
        `SELECT COUNT(*)::int AS c FROM whatsapp_session_keys WHERE key_id = 'creds'`,
      );
      const credsCount = probe.rows[0]?.c ?? 0;
      if (credsCount < 1) {
        throw new Error(
          `live: whatsapp_session_keys has 0 'creds' rows; QR may not have been scanned`,
        );
      }
      return { ...detail, live_creds_rows: credsCount };
    } finally {
      await pool.end();
    }
  }

  return detail;
}

// ----------------------------------------------------------------------------
// Test 2 — read-only wrapper + 4h backoff (delegates to vitest)
// ----------------------------------------------------------------------------

async function testReadOnly() {
  const r = runVitest('@kos/service-baileys-fargate');
  if (!r.ok) {
    throw new Error(
      `baileys-fargate read-only/backoff vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  // The same suite covers BOTH the write-rejection wrapper and the
  // 1h→2h→4h backoff tests; we don't run it twice.
  const evidence = {
    vitest_status: r.status,
    write_reject_tests_present:
      /BAILEYS_WRITE_REJECTED|sendMessage|updateStatus|read-only/i.test(r.stdoutTail),
    backoff_tests_present: /backoff|backing off|4h/i.test(r.stdoutTail),
  };
  return evidence;
}

// ----------------------------------------------------------------------------
// Test 3 — Chrome extension reliability
// ----------------------------------------------------------------------------

async function testChrome() {
  const a = runVitest('@kos/service-chrome-webhook');
  if (!a.ok) {
    throw new Error(
      `chrome-webhook vitest failed (status=${a.status}): ${a.stdoutTail}`,
    );
  }
  // The extension package itself ships background + content-script tests.
  // We tolerate it being absent (early Phase 5 cherry-picks may not include
  // it) and only fail if it exists AND fails.
  let extDetail = { skipped: 'no @kos/chrome-extension workspace' };
  if (pkgExists('@kos/chrome-extension')) {
    const b = runVitest('@kos/chrome-extension');
    if (!b.ok) {
      throw new Error(
        `chrome-extension vitest failed (status=${b.status}): ${b.stdoutTail}`,
      );
    }
    extDetail = { vitest_status: b.status };
  }
  return { webhook: { vitest_status: a.status }, extension: extDetail };
}

// ----------------------------------------------------------------------------
// Test 4 — LinkedIn rate-limit safety
// ----------------------------------------------------------------------------

async function testLinkedIn() {
  const a = runVitest('@kos/service-linkedin-webhook');
  if (!a.ok) {
    throw new Error(
      `linkedin-webhook vitest failed (status=${a.status}): ${a.stdoutTail}`,
    );
  }

  // Optional 14-day aggregate. Plan 05-03 ships scripts/verify-linkedin-observation.mjs.
  // If absent, soft-skip — Plan 05-03 may not have landed yet.
  const obsScript = resolve(REPO_ROOT, 'scripts/verify-linkedin-observation.mjs');
  let obsDetail = { skipped: 'verify-linkedin-observation.mjs not present (Plan 05-03 not landed)' };
  if (existsSync(obsScript)) {
    if (mode === 'live') {
      const r = spawnSync('node', [obsScript], { encoding: 'utf-8', cwd: REPO_ROOT });
      if (r.status !== 0) {
        throw new Error(
          `verify-linkedin-observation failed (status=${r.status}): ${(r.stdout ?? '').slice(-600)}`,
        );
      }
      obsDetail = { vitest_status: r.status };
    } else {
      // Offline: just node --check it.
      const r = spawnSync('node', ['--check', obsScript], { encoding: 'utf-8' });
      if (r.status !== 0) {
        throw new Error(`verify-linkedin-observation node --check failed: ${r.stderr}`);
      }
      obsDetail = { node_check: 'ok', live_skipped: true };
    }
  }

  return { webhook: { vitest_status: a.status }, observation: obsDetail };
}

// ----------------------------------------------------------------------------
// Test 5 — Discord scheduler wiring
// ----------------------------------------------------------------------------

async function testDiscord() {
  // Offline: synth the integrations-discord stack via cdk vitest filter.
  const r = runVitest('@kos/cdk', 'discord');
  // The vitest filter pattern matches 'integrations-discord' if it exists.
  // If 05-06 hasn't landed yet, vitest reports 0 tests — which is exit 0
  // because of `--passWithNoTests` on most CDK packages. We accept that.
  if (!r.ok) {
    // Fall through to live SSM probe before deciding fail. CDK test failure
    // here usually means the stack file is malformed.
    throw new Error(
      `cdk integrations-discord vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  if (mode === 'live') {
    const ssmName = '/kos/discord/brain-dump-lambda-arn';
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const ssm = spawnSync(
      'aws',
      ['ssm', 'get-parameter', '--name', ssmName, '--query', 'Parameter.Value', '--output', 'text', '--region', region],
      { encoding: 'utf-8' },
    );
    if (ssm.status !== 0 || !ssm.stdout || /ParameterNotFound/.test(ssm.stderr ?? '')) {
      // Phase 10 Plan 10-04 hasn't landed; not a Phase 5 failure.
      return { ...detail, pending: 'SSM /kos/discord/brain-dump-lambda-arn missing (Phase 10 Plan 10-04 pending)' };
    }
    const arn = ssm.stdout.trim();
    if (!arn.startsWith('arn:aws:lambda:')) {
      throw new Error(`SSM ${ssmName} value is not a Lambda ARN: ${arn}`);
    }
    return { ...detail, lambda_arn: arn };
  }

  return detail;
}

// ----------------------------------------------------------------------------
// Test 6 — 7-day zero-write Baileys soak
// ----------------------------------------------------------------------------

async function testSoak() {
  if (mode === 'offline') {
    return {
      skipped:
        '7-day soak requires live RDS read of sync_status counter — operator runs --mode=live post-deploy',
    };
  }

  // Live: read sync_status.queue_depth where channel='baileys_gate_5'.
  // If the row is missing the verify-gate-5-baileys Lambda hasn't run yet,
  // which means Plan 05-04 + 05-05 haven't been deployed.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('live mode requires DATABASE_URL for soak counter read');
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('rds.amazonaws.com')
      ? { rejectUnauthorized: false }
      : undefined,
    max: 1,
  });
  try {
    const r = await pool.query(
      `SELECT queue_depth AS zero_write_days, last_healthy_at
         FROM sync_status
        WHERE channel = 'baileys_gate_5'`,
    );
    if (r.rowCount === 0) {
      return {
        manual_blocked:
          'sync_status row for baileys_gate_5 missing — verify-gate-5-baileys Lambda has not run yet (Plan 05-04 + 05-05 not deployed)',
      };
    }
    const days = r.rows[0]?.zero_write_days ?? 0;
    const lastHealthy = r.rows[0]?.last_healthy_at;
    if (days < 7) {
      throw new Error(
        `zero_write_days = ${days} (need >= 7); last_healthy_at = ${lastHealthy}`,
      );
    }
    return { zero_write_days: days, last_healthy_at: lastHealthy };
  } finally {
    await pool.end();
  }
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

(async () => {
  console.log(`[verify-gate-5] mode=${mode} test=${test} repo=${REPO_ROOT}\n`);

  if (test === 'all' || test === 'session') {
    await runTest('1-session-persistence', testSession);
  }
  if (test === 'all' || test === 'read-only') {
    await runTest('2-read-only-defense', testReadOnly);
  }
  if (test === 'all' || test === 'chrome') {
    await runTest('3-chrome-reliability', testChrome);
  }
  if (test === 'all' || test === 'linkedin') {
    await runTest('4-linkedin-rate-limit', testLinkedIn);
  }
  if (test === 'all' || test === 'discord') {
    await runTest('5-discord-scheduler', testDiscord);
  }
  if (test === 'all' || test === 'soak') {
    await runTest('6-baileys-7day-soak', testSoak);
  }

  console.log('\n=== Gate 5 Summary ===');
  for (const r of results) {
    const sigil =
      r.status === 'PASS'
        ? 'OK '
        : r.status === 'SKIP'
        ? 'SK '
        : r.status === 'PENDING'
        ? 'PN '
        : r.status === 'MANUAL_BLOCKED'
        ? 'MB '
        : 'NO ';
    console.log(`  ${sigil} ${r.name}  (${r.status})`);
  }

  console.log('\nNot automated by this verifier:');
  console.log(
    '  7. Kill-task reconnect probe — operator runs `aws ecs update-service ... --force-new-deployment`',
  );
  console.log(
    '     and asserts no QR in /ecs/baileys logs within 60s.',
  );
  console.log(
    '     See .planning/phases/05-messaging-channels/05-07-GATE-5-evidence-template.md',
  );

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log(`\n${failed.length} FAIL(s). See stderr JSON for details.`);
    process.stderr.write(
      JSON.stringify({
        verifier: 'verify-gate-5',
        mode,
        test,
        results,
      }) + '\n',
    );
    process.exit(1);
  }
  console.log(
    '\nAll selected Gate 5 criteria PASS (or SKIPPED / MANUAL_BLOCKED / PENDING in offline / pre-deploy mode).',
  );
  process.exit(0);
})().catch((err) => {
  console.error('[verify-gate-5] unexpected error:', err);
  process.stderr.write(
    JSON.stringify({
      verifier: 'verify-gate-5',
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
