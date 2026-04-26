#!/usr/bin/env node
/**
 * verify-phase-4-e2e.mjs — Phase 4 end-to-end verifier.
 *
 * Walks the 5 ROADMAP §Phase 4 success criteria. Each SC is mapped to a
 * concrete subprocess (vitest filter or node script) so this verifier is
 * the single command an operator runs to confirm Phase 4 health.
 *
 * Mapping:
 *   SC1 — iOS Shortcut HMAC → Transcribe → triage  (10s clip < 25s)
 *         offline: pnpm --filter @kos/service-ios-webhook test
 *         live:   operator-driven with curl + CloudWatch (printed reminder)
 *
 *   SC2 — SES forward → S3 → capture.received  +
 *          EmailEngine → IMAP IDLE → capture.received (7-day soak manual)
 *         offline: pnpm --filter @kos/service-ses-inbound test
 *                  pnpm --filter @kos/service-emailengine-webhook test
 *         live:   the SES rule-set + EmailEngine licence are operator-owned;
 *                 the 7-day soak is verified via CloudWatch metric filter
 *                 (see 04-EMAILENGINE-OPERATOR-RUNBOOK.md step 11)
 *
 *   SC3 — Gate 3 (idempotency + prompt-injection + Approve/Edit/Skip)
 *         delegates to scripts/verify-gate-3.mjs --mode=<mode>
 *
 *   SC4 — AGT-05 Haiku classify + Sonnet draft for urgent → Inbox
 *         offline: pnpm --filter @kos/service-email-triage test
 *
 *   SC5 — Tool-call resilience (10s timeout + 2 retries + agent_dead_letter
 *          + Inbox dead-letter card; no Telegram per CAP-14 quiet-hours
 *          adjacent contract)
 *         offline: vitest run on services/_shared/with-timeout-retry.test.ts
 *                  via the @kos/contracts workspace (which co-locates _shared
 *                  and contracts).
 *
 * Exit codes:
 *   0 — every selected SC PASS
 *   1 — any SC FAIL
 *   2 — usage error
 *
 * Output:
 *   stdout: per-SC pass/fail summary
 *   stderr: structured JSON on failure
 *
 * Usage:
 *   node scripts/verify-phase-4-e2e.mjs                  # offline (default)
 *   node scripts/verify-phase-4-e2e.mjs --mode=live      # post-deploy
 *
 * Reference:
 *   .planning/phases/04-email-pipeline-ios-capture/04-06-PLAN.md
 *   .planning/ROADMAP.md §Phase 4
 *   scripts/verify-phase-2-e2e.mjs (Phase 2 sibling)
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'offline' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`Usage: node scripts/verify-phase-4-e2e.mjs [--mode=offline|live]

Walks all 5 ROADMAP §Phase 4 success criteria. SC3 delegates to
verify-gate-3.mjs. Offline mode is the pre-deploy CI smoke; live mode is
the post-deploy operator checklist.
`);
  process.exit(0);
}

const mode = String(values.mode);
if (!['offline', 'live'].includes(mode)) {
  console.error(`[verify-phase-4-e2e] unknown --mode=${mode}`);
  process.exit(2);
}

// ----------------------------------------------------------------------------
// Resolve repo root (script lives in scripts/)
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ----------------------------------------------------------------------------
// Result accumulator
// ----------------------------------------------------------------------------

/** @typedef {{ name: string, status: 'PASS'|'FAIL'|'SKIP', detail?: object }} ScResult */
/** @type {ScResult[]} */
const results = [];

function pushResult(name, status, detail) {
  results.push({ name, status, detail });
  const sigil = status === 'PASS' ? 'OK ' : status === 'SKIP' ? 'SK ' : 'NO ';
  console.log(`[${name}] ${sigil} ${status}`);
}

/**
 * Run a subprocess; returns { ok, stderrTail, stdoutTail }.
 */
function runSubprocess(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', cwd: REPO_ROOT });
  return {
    ok: r.status === 0,
    status: r.status,
    stdoutTail: (r.stdout ?? '').slice(-1500),
    stderrTail: (r.stderr ?? '').slice(-1500),
  };
}

// ----------------------------------------------------------------------------
// SC1 — iOS Shortcut path (offline proxy: ios-webhook unit tests)
// ----------------------------------------------------------------------------

function runSc1() {
  const r = runSubprocess('pnpm', [
    '--filter',
    '@kos/service-ios-webhook',
    'test',
    '--',
    '--run',
    '--reporter=basic',
  ]);
  if (r.ok) {
    pushResult('SC1-ios-webhook', 'PASS', { vitest_status: r.status });
  } else {
    pushResult('SC1-ios-webhook', 'FAIL', {
      vitest_status: r.status,
      stdout_tail: r.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC2 — SES inbound + EmailEngine webhook (offline proxies)
// ----------------------------------------------------------------------------

function runSc2() {
  const a = runSubprocess('pnpm', [
    '--filter',
    '@kos/service-ses-inbound',
    'test',
    '--',
    '--run',
    '--reporter=basic',
  ]);
  if (a.ok) {
    pushResult('SC2a-ses-inbound', 'PASS', { vitest_status: a.status });
  } else {
    pushResult('SC2a-ses-inbound', 'FAIL', {
      vitest_status: a.status,
      stdout_tail: a.stdoutTail,
    });
  }

  const b = runSubprocess('pnpm', [
    '--filter',
    '@kos/service-emailengine-webhook',
    'test',
    '--',
    '--run',
    '--reporter=basic',
  ]);
  if (b.ok) {
    pushResult('SC2b-emailengine-webhook', 'PASS', { vitest_status: b.status });
  } else {
    pushResult('SC2b-emailengine-webhook', 'FAIL', {
      vitest_status: b.status,
      stdout_tail: b.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC3 — Gate 3 delegation (verify-gate-3.mjs)
// ----------------------------------------------------------------------------

function runSc3() {
  const gate3Script = resolve(REPO_ROOT, 'scripts/verify-gate-3.mjs');
  if (!existsSync(gate3Script)) {
    pushResult('SC3-gate-3', 'FAIL', {
      reason: `verify-gate-3.mjs not found at ${gate3Script}`,
    });
    return;
  }
  const r = runSubprocess('node', [gate3Script, `--mode=${mode}`]);
  if (r.ok) {
    pushResult('SC3-gate-3', 'PASS', { exit_status: r.status });
  } else {
    pushResult('SC3-gate-3', 'FAIL', {
      exit_status: r.status,
      stderr_tail: r.stderrTail,
      stdout_tail: r.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC4 — email-triage (Haiku classify + Sonnet draft)
// ----------------------------------------------------------------------------

function runSc4() {
  const r = runSubprocess('pnpm', [
    '--filter',
    '@kos/service-email-triage',
    'test',
    '--',
    '--run',
    '--reporter=basic',
  ]);
  if (r.ok) {
    pushResult('SC4-email-triage', 'PASS', { vitest_status: r.status });
  } else {
    pushResult('SC4-email-triage', 'FAIL', {
      vitest_status: r.status,
      stdout_tail: r.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC5 — withTimeoutAndRetry resilience tests
// ----------------------------------------------------------------------------

function runSc5() {
  // services/_shared has no package.json of its own; the with-timeout-retry
  // test is co-located there and is exercised by the @kos/service-email-triage
  // and @kos/service-email-sender packages that depend on it. To run JUST
  // this single test file, point vitest directly at it from the repo root.
  const testFile = resolve(
    REPO_ROOT,
    'services/_shared/with-timeout-retry.test.ts',
  );
  if (!existsSync(testFile)) {
    pushResult('SC5-with-timeout-retry', 'FAIL', {
      reason: `test file missing: ${testFile}`,
    });
    return;
  }
  const r = runSubprocess('npx', [
    '--no-install',
    'vitest',
    'run',
    '--reporter=basic',
    testFile,
  ]);
  if (r.ok) {
    pushResult('SC5-with-timeout-retry', 'PASS', { vitest_status: r.status });
  } else {
    pushResult('SC5-with-timeout-retry', 'FAIL', {
      vitest_status: r.status,
      stdout_tail: r.stdoutTail,
      stderr_tail: r.stderrTail,
    });
  }
}

// ----------------------------------------------------------------------------
// Manual-only reminders (live mode)
// ----------------------------------------------------------------------------

function printManualChecks() {
  console.log('\n=== Manual operator checks (NOT automated) ===');
  console.log(
    '  • SC1 latency  — fire 10s sv-SE voice clip via iOS Shortcut; assert end-to-end < 25s',
  );
  console.log(
    '                   (curl + CloudWatch StartTranscriptionJob → triage log)',
  );
  console.log(
    '  • SC2 soak     — EmailEngine `EmailEngineAuthFailures` Sum=0 for 7 daily buckets',
  );
  console.log(
    '                   (04-EMAILENGINE-OPERATOR-RUNBOOK.md step 11)',
  );
  console.log(
    '  • SC3 #4       — Approve a real urgent draft in /inbox → SES MessageId in CloudWatch',
  );
  console.log(
    '                   (requires SES production-access OR verified test recipient)',
  );
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

(async () => {
  console.log(
    `[verify-phase-4-e2e] mode=${mode} repo=${REPO_ROOT}\n`,
  );

  runSc1();
  runSc2();
  runSc3();
  runSc4();
  runSc5();

  console.log('\n=== Phase 4 E2E Summary ===');
  for (const r of results) {
    const sigil = r.status === 'PASS' ? 'OK ' : r.status === 'SKIP' ? 'SK ' : 'NO ';
    console.log(`  ${sigil} ${r.name}  (${r.status})`);
  }

  printManualChecks();

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log(`\n${failed.length} SC failure(s). See stderr JSON for details.`);
    process.stderr.write(
      JSON.stringify({
        verifier: 'verify-phase-4-e2e',
        mode,
        results,
      }) + '\n',
    );
    process.exit(1);
  }
  console.log('\nAll Phase 4 success criteria PASS in offline mode.');
  if (mode === 'offline') {
    console.log(
      'Run again with --mode=live after deploy to exercise the manual checks above.',
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('[verify-phase-4-e2e] unexpected error:', err);
  process.stderr.write(
    JSON.stringify({
      verifier: 'verify-phase-4-e2e',
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
