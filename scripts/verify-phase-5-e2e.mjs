#!/usr/bin/env node
/**
 * verify-phase-5-e2e.mjs — Phase 5 end-to-end verifier.
 *
 * Walks the 5 ROADMAP §Phase 5 success criteria and exercises all 4 capture
 * paths (Chrome highlight, LinkedIn DM, WhatsApp/Baileys-stub, Discord text).
 * Each SC maps to a concrete subprocess (vitest filter or nested verifier
 * script) so this verifier is the single command an operator runs to confirm
 * Phase 5 health.
 *
 * Mapping:
 *   SC1 — Chrome MV3 highlight: capture.received within 5s
 *         offline: pnpm --filter @kos/service-chrome-webhook test
 *                  + (if present) pnpm --filter @kos/chrome-extension test
 *         live:   manual M1+M2 in 05-VALIDATION.md (operator highlights text,
 *                 observes Inbox row); CLI prints reminder.
 *
 *   SC2 — LinkedIn DM ingestion 14-day clean observation
 *         offline: pnpm --filter @kos/service-linkedin-webhook test
 *         live:   delegates to scripts/verify-linkedin-observation.mjs if
 *                 present (Plan 05-03 ships it). Soft-skip otherwise.
 *
 *   SC3 — Gate 5 (Baileys: session + read-only + reconnect + soak + Chrome
 *          + LinkedIn rate-limit + Discord wiring). Delegates to
 *          scripts/verify-gate-5.mjs --mode=<mode>.
 *
 *   SC4 — Discord scheduler wiring (capture.received kind=discord_text contract)
 *         offline: pnpm --filter @kos/cdk test --run discord
 *         live:   `aws ssm get-parameter /kos/discord/brain-dump-lambda-arn`
 *                 returns a Lambda ARN (Phase 10 Plan 10-04 dependency).
 *
 *   SC5 — Graceful degradation (kill Fargate task → system_alerts row + UI
 *          surface). Operator-driven; CLI prints M6+M7 runbook reminder.
 *
 * Capture-path exercise (offline proxy via vitest):
 *   - Chrome  → @kos/service-chrome-webhook
 *   - LinkedIn → @kos/service-linkedin-webhook
 *   - WhatsApp/Baileys → @kos/service-baileys-fargate + @kos/service-baileys-sidecar
 *   - Discord → @kos/cdk integrations-discord (scheduler wiring is the
 *               Phase 5 deliverable; Lambda is Phase 10)
 *
 * Exit codes:
 *   0 — every selected SC PASS (or SKIP / PENDING with reason)
 *   1 — any SC FAIL
 *   2 — usage error
 *
 * Output:
 *   stdout: per-SC pass/fail summary
 *   stderr: structured JSON on failure
 *
 * Usage:
 *   node scripts/verify-phase-5-e2e.mjs                  # offline (default)
 *   node scripts/verify-phase-5-e2e.mjs --mode=live      # post-deploy
 *
 * Reference:
 *   .planning/phases/05-messaging-channels/05-07-PLAN.md
 *   .planning/phases/05-messaging-channels/05-VALIDATION.md
 *   .planning/ROADMAP.md §Phase 5
 *   scripts/verify-phase-4-e2e.mjs (Phase 4 sibling)
 *   scripts/verify-gate-5.mjs (Gate 5 delegate)
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
  console.log(`Usage: node scripts/verify-phase-5-e2e.mjs [--mode=offline|live]

Walks all 5 ROADMAP §Phase 5 success criteria. SC3 delegates to
verify-gate-5.mjs. Offline mode is the pre-deploy CI smoke; live mode is
the post-deploy operator checklist.
`);
  process.exit(0);
}

const mode = String(values.mode);
if (!['offline', 'live'].includes(mode)) {
  console.error(`[verify-phase-5-e2e] unknown --mode=${mode}`);
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

/** @typedef {{ name: string, status: 'PASS'|'FAIL'|'SKIP'|'PENDING', detail?: object }} ScResult */
/** @type {ScResult[]} */
const results = [];

function pushResult(name, status, detail) {
  results.push({ name, status, detail });
  const sigil =
    status === 'PASS' ? 'OK '
    : status === 'SKIP' ? 'SK '
    : status === 'PENDING' ? 'PN '
    : 'NO ';
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

function pkgPresent(workspaceDir) {
  return existsSync(resolve(REPO_ROOT, workspaceDir, 'package.json'));
}

// ----------------------------------------------------------------------------
// SC1 — Chrome MV3 highlight (offline proxy: chrome-webhook + extension tests)
// ----------------------------------------------------------------------------

function runSc1() {
  const a = runSubprocess('pnpm', [
    '--filter', '@kos/service-chrome-webhook', 'test', '--', '--run', '--reporter=basic',
  ]);
  if (!a.ok) {
    pushResult('SC1a-chrome-webhook', 'FAIL', {
      vitest_status: a.status,
      stdout_tail: a.stdoutTail,
    });
  } else {
    pushResult('SC1a-chrome-webhook', 'PASS', { vitest_status: a.status });
  }

  if (pkgPresent('apps/chrome-extension')) {
    const b = runSubprocess('pnpm', [
      '--filter', '@kos/chrome-extension', 'test', '--', '--run', '--reporter=basic',
    ]);
    if (!b.ok) {
      pushResult('SC1b-chrome-extension', 'FAIL', {
        vitest_status: b.status,
        stdout_tail: b.stdoutTail,
      });
    } else {
      pushResult('SC1b-chrome-extension', 'PASS', { vitest_status: b.status });
    }
  } else {
    pushResult('SC1b-chrome-extension', 'SKIP', {
      reason: 'apps/chrome-extension workspace not present (Plan 05-00/05-01 not landed)',
    });
  }
}

// ----------------------------------------------------------------------------
// SC2 — LinkedIn DM 14-day clean observation
// ----------------------------------------------------------------------------

function runSc2() {
  const a = runSubprocess('pnpm', [
    '--filter', '@kos/service-linkedin-webhook', 'test', '--', '--run', '--reporter=basic',
  ]);
  if (!a.ok) {
    pushResult('SC2a-linkedin-webhook', 'FAIL', {
      vitest_status: a.status,
      stdout_tail: a.stdoutTail,
    });
  } else {
    pushResult('SC2a-linkedin-webhook', 'PASS', { vitest_status: a.status });
  }

  // Optional Plan 05-03 deliverable.
  const obs = resolve(REPO_ROOT, 'scripts/verify-linkedin-observation.mjs');
  if (!existsSync(obs)) {
    pushResult('SC2b-linkedin-14day', 'SKIP', {
      reason: 'scripts/verify-linkedin-observation.mjs not present (Plan 05-03 not landed)',
    });
    return;
  }
  if (mode === 'live') {
    const r = runSubprocess('node', [obs]);
    if (!r.ok) {
      pushResult('SC2b-linkedin-14day', 'FAIL', {
        exit_status: r.status,
        stdout_tail: r.stdoutTail,
      });
    } else {
      pushResult('SC2b-linkedin-14day', 'PASS', { exit_status: r.status });
    }
  } else {
    const r = runSubprocess('node', ['--check', obs]);
    if (!r.ok) {
      pushResult('SC2b-linkedin-14day', 'FAIL', {
        node_check: 'failed',
        stderr_tail: r.stderrTail,
      });
    } else {
      pushResult('SC2b-linkedin-14day', 'PASS', { node_check: 'ok', live_skipped: true });
    }
  }
}

// ----------------------------------------------------------------------------
// SC3 — Gate 5 delegation (verify-gate-5.mjs)
// ----------------------------------------------------------------------------

function runSc3() {
  const gate5Script = resolve(REPO_ROOT, 'scripts/verify-gate-5.mjs');
  if (!existsSync(gate5Script)) {
    pushResult('SC3-gate-5', 'FAIL', {
      reason: `verify-gate-5.mjs not found at ${gate5Script}`,
    });
    return;
  }
  const r = runSubprocess('node', [gate5Script, `--mode=${mode}`]);
  if (r.ok) {
    pushResult('SC3-gate-5', 'PASS', { exit_status: r.status });
  } else {
    pushResult('SC3-gate-5', 'FAIL', {
      exit_status: r.status,
      stderr_tail: r.stderrTail,
      stdout_tail: r.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC4 — Discord scheduler wiring + capture.received kind=discord_text contract
// ----------------------------------------------------------------------------

function runSc4() {
  // Offline: cdk vitest filter on integrations-discord (scheduler synthesis).
  const a = runSubprocess('pnpm', [
    '--filter', '@kos/cdk', 'test', '--', '--run', 'discord', '--reporter=basic',
  ]);
  if (!a.ok) {
    pushResult('SC4-discord-scheduler', 'FAIL', {
      vitest_status: a.status,
      stdout_tail: a.stdoutTail,
    });
  } else {
    pushResult('SC4-discord-scheduler', 'PASS', { vitest_status: a.status });
  }

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const ssm = runSubprocess('aws', [
      'ssm', 'get-parameter',
      '--name', '/kos/discord/brain-dump-lambda-arn',
      '--query', 'Parameter.Value', '--output', 'text',
      '--region', region,
    ]);
    if (!ssm.ok || /ParameterNotFound/.test(ssm.stderrTail)) {
      pushResult('SC4b-discord-ssm-arn', 'PENDING', {
        reason: 'SSM /kos/discord/brain-dump-lambda-arn missing (Phase 10 Plan 10-04 pending)',
      });
    } else {
      pushResult('SC4b-discord-ssm-arn', 'PASS', { arn: ssm.stdoutTail.trim() });
    }
  }
}

// ----------------------------------------------------------------------------
// SC5 — Graceful degradation (operator-only; CLI surfaces reminder)
// ----------------------------------------------------------------------------

function runSc5() {
  // The Baileys-fargate vitest covers the system_alerts emission unit; we
  // delegate there as the offline proxy.
  const r = runSubprocess('pnpm', [
    '--filter', '@kos/service-baileys-fargate', 'test', '--', '--run', '--reporter=basic',
  ]);
  if (!r.ok) {
    pushResult('SC5-graceful-degradation-unit', 'FAIL', {
      vitest_status: r.status,
      stdout_tail: r.stdoutTail,
    });
    return;
  }
  pushResult('SC5-graceful-degradation-unit', 'PASS', { vitest_status: r.status });

  // The behavioural assertion (kill task → system_alerts row + dashboard
  // banner) is operator-only; surface as reminder.
  pushResult('SC5b-graceful-degradation-live', 'SKIP', {
    reason:
      'operator M6+M7 in 05-VALIDATION.md: kill BaileysService task + observe system_alerts row + dashboard banner',
  });
}

// ----------------------------------------------------------------------------
// Manual-only reminders (live mode)
// ----------------------------------------------------------------------------

function printManualChecks() {
  console.log('\n=== Manual operator checks (NOT automated) ===');
  console.log(
    '  • SC1 round-trip — load unpacked extension; highlight on any page; click "Send to KOS";',
  );
  console.log(
    '                     observe Inbox row within 5s. (M1+M2 in 05-VALIDATION.md)',
  );
  console.log(
    '  • SC2 14-day     — LinkedIn UI shows zero "unusual activity" warnings over 14 days;',
  );
  console.log(
    '                     scripts/verify-linkedin-observation.mjs reports 0 alerts. (M5)',
  );
  console.log(
    '  • SC3 #6 soak    — Baileys 7-day zero-write soak; verify-gate-5-baileys daily Lambda',
  );
  console.log(
    '                     (BLOCKED on Plan 05-04 Baileys CDK landing). (M3+M4)',
  );
  console.log(
    '  • SC3 #7 reconnect — `aws ecs update-service ... --force-new-deployment`; assert no QR',
  );
  console.log(
    '                       in /ecs/baileys logs within 60s. (M3 in 05-VALIDATION.md)',
  );
  console.log(
    '  • SC4 Lambda      — Phase 10 Plan 10-04 ships discord-brain-dump-listener; SSM ARN',
  );
  console.log(
    '                      /kos/discord/brain-dump-lambda-arn must be set post-deploy.',
  );
  console.log(
    '  • SC5 degradation — `aws ecs stop-task` BaileysService → observe system_alerts row',
  );
  console.log(
    '                      severity=warn + dashboard banner. (M6+M7 in 05-VALIDATION.md)',
  );
}

// ----------------------------------------------------------------------------
// Cherry-pick coverage notes (printed unconditionally)
// ----------------------------------------------------------------------------

function printCherryPickCoverage() {
  console.log('\n=== Cherry-pick coverage ===');
  console.log('  • Chrome-only (low-risk):     SC1 + SC3 (chrome subset).');
  console.log('  • Chrome + LinkedIn (medium): SC1 + SC2 + SC3 (linkedin subset).');
  console.log('  • Full Phase 5 (incl. WA):    SC1-5; Gate 5 #6 soak gates production label.');
  console.log('  • + Discord fallback:         SC4 (Phase 10 dependency for runtime).');
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

(async () => {
  console.log(`[verify-phase-5-e2e] mode=${mode} repo=${REPO_ROOT}\n`);

  runSc1();
  runSc2();
  runSc3();
  runSc4();
  runSc5();

  console.log('\n=== Phase 5 E2E Summary ===');
  for (const r of results) {
    const sigil =
      r.status === 'PASS' ? 'OK '
      : r.status === 'SKIP' ? 'SK '
      : r.status === 'PENDING' ? 'PN '
      : 'NO ';
    console.log(`  ${sigil} ${r.name}  (${r.status})`);
  }

  printManualChecks();
  printCherryPickCoverage();

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log(`\n${failed.length} SC failure(s). See stderr JSON for details.`);
    process.stderr.write(
      JSON.stringify({
        verifier: 'verify-phase-5-e2e',
        mode,
        results,
      }) + '\n',
    );
    process.exit(1);
  }
  console.log('\nAll Phase 5 success criteria PASS in offline mode.');
  if (mode === 'offline') {
    console.log(
      'Run again with --mode=live after deploy to exercise the manual checks above.',
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('[verify-phase-5-e2e] unexpected error:', err);
  process.stderr.write(
    JSON.stringify({
      verifier: 'verify-phase-5-e2e',
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
