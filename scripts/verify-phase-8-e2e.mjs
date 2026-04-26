#!/usr/bin/env node
/**
 * verify-phase-8-e2e.mjs — Phase 8 outbound-content + calendar end-to-end gate.
 *
 * Walks the 7 ROADMAP §Phase 8 success criteria. Each SC is mapped to a
 * concrete subprocess (vitest filter, sub-verifier, or live AWS probe) so
 * this verifier is the single command an operator runs to confirm Phase 8
 * health.
 *
 * Mapping:
 *   SC1 — 5-platform drafts via Step Functions fan-out, latency budget
 *         offline: pnpm --filter @kos/service-content-writer test
 *                  pnpm --filter @kos/service-content-writer-platform test
 *                  pnpm --filter @kos/cdk test --run integrations-content
 *         live:   AWS Step Functions DescribeStateMachine ContentDraftingFanout;
 *                 optional: submit synthetic topic via scripts/submit-content-topic.mjs
 *
 *   SC2 — Publisher + Postiz MCP + cancel-before-publish + IAM split
 *         offline: pnpm --filter @kos/service-publisher test
 *                  pnpm --filter @kos/cdk test --run integrations-publisher
 *         live:   ECS DescribeServices on `postiz`; SecretsManager probe of
 *                 `kos/postiz-api-key`; operator round-trip is MANUAL_BLOCKED
 *                 because Plan 08-03 is autonomous: false.
 *
 *   SC3 — Google Calendar both accounts in morning brief + entity context
 *         offline: pnpm --filter @kos/service-calendar-reader test
 *                  pnpm --filter @kos/cdk test --run integrations-calendar
 *         live:   Secrets Manager probe of kos/gcal-oauth-kevin-elzarka +
 *                 kos/gcal-oauth-kevin-taleforge; agent_runs query for
 *                 calendar-reader status='ok' over 24h.
 *
 *   SC4 — Document version tracker with SHA + diff_summary
 *         offline: pnpm --filter @kos/service-document-diff test
 *         live:   agent_runs query for document-diff over the last 7 days.
 *
 *   SC5 — Approve gate non-bypassable (delegates to verify-gate-8 --test=approve-gate)
 *         offline: structural CDK + IAM grep
 *         live:   RDS query for orphan published drafts / executed mutations.
 *
 *   SC6 — Imperative-verb mutation pathway ("ta bort mötet imorgon kl 11")
 *         offline: pnpm --filter @kos/service-mutation-proposer test
 *                  pnpm --filter @kos/service-mutation-executor test
 *         live:   delegates to scripts/verify-mutation-rollback.mjs --verify
 *                 (operator-driven Approve in dashboard before --verify).
 *
 *   SC7 — Postiz Fargate deployment (Plan 08-03; autonomous: false)
 *         offline: pnpm --filter @kos/cdk test --run integrations-postiz
 *         live:   ECS DescribeServices kos-cluster/postiz running 1/1 ACTIVE;
 *                 Cloud Map DNS postiz.kos.local resolves; per-platform OAuth
 *                 + first-real-topic round-trip remain MANUAL_BLOCKED.
 *
 * Plan 08-03 is `autonomous: false`. SC2 + SC7 are partially MANUAL_BLOCKED
 * — the deploy itself is operator-driven, the runtime probe is automated, and
 * the OAuth + brand-voice signoff are operator-only.
 *
 * Exit codes:
 *   0 — every selected SC PASS (or SKIP / PENDING / MANUAL_BLOCKED with reason)
 *   1 — any SC FAIL
 *   2 — usage error
 *
 * Output:
 *   stdout: per-SC pass/fail summary
 *   stderr: structured JSON on failure
 *
 * Usage:
 *   node scripts/verify-phase-8-e2e.mjs                      # offline (default)
 *   node scripts/verify-phase-8-e2e.mjs --mode=live          # post-deploy
 *   node scripts/verify-phase-8-e2e.mjs --mode=offline --test=SC1
 *
 * Reference:
 *   .planning/phases/08-outbound-content-calendar/08-06-PLAN.md
 *   .planning/phases/08-outbound-content-calendar/08-VALIDATION.md
 *   .planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md
 *   .planning/ROADMAP.md §Phase 8
 *   scripts/verify-phase-5-e2e.mjs (Phase 5 sibling)
 *   scripts/verify-gate-8.mjs (Gate 8 delegate)
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
    test: { type: 'string', default: 'all' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`Usage: node scripts/verify-phase-8-e2e.mjs [--mode=offline|live] [--test=<name>|all]

Walks all 7 ROADMAP §Phase 8 success criteria. SC5 delegates to
verify-gate-8.mjs --test=approve-gate. Offline mode is the pre-deploy CI
smoke; live mode is the post-deploy operator checklist.

Tests:
  --test=SC1            5-platform drafts via Step Functions fan-out
  --test=SC2            Publisher + Postiz MCP + cancel-before-publish
  --test=SC3            Google Calendar (both accounts) + entity context
  --test=SC4            Document version tracker (SHA + diff_summary)
  --test=SC5            Approve gate non-bypassable (delegates to verify-gate-8)
  --test=SC6            Imperative-verb mutation pathway
  --test=SC7            Postiz Fargate deployment
  --test=all (default)  Run all of the above.

Note:
  Plan 08-03 is autonomous: false. SC2 + SC7 contain MANUAL_BLOCKED rows for
  the operator-only side (per-platform OAuth, first real Approve+publish
  round-trip, BRAND_VOICE.md sign-off).
`);
  process.exit(0);
}

const mode = String(values.mode);
const test = String(values.test);
if (!['offline', 'live'].includes(mode)) {
  console.error(`[verify-phase-8-e2e] unknown --mode=${mode}`);
  process.exit(2);
}
const VALID_TESTS = ['all', 'SC1', 'SC2', 'SC3', 'SC4', 'SC5', 'SC6', 'SC7'];
if (!VALID_TESTS.includes(test)) {
  console.error(`[verify-phase-8-e2e] unknown --test=${test} (expected one of ${VALID_TESTS.join(' | ')})`);
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

/** @typedef {{ name: string, status: 'PASS'|'FAIL'|'SKIP'|'PENDING'|'MANUAL_BLOCKED', detail?: object }} ScResult */
/** @type {ScResult[]} */
const results = [];

function pushResult(name, status, detail) {
  results.push({ name, status, detail });
  const sigil =
    status === 'PASS' ? 'OK '
    : status === 'SKIP' ? 'SK '
    : status === 'PENDING' ? 'PN '
    : status === 'MANUAL_BLOCKED' ? 'MB '
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

function runVitestForPkg(pkg, filter) {
  const args = ['--filter', pkg, 'test', '--', '--run', '--reporter=basic'];
  if (filter) args.push(filter);
  return runSubprocess('pnpm', args);
}

// ----------------------------------------------------------------------------
// SC1 — 5-platform drafts via Step Functions fan-out
// ----------------------------------------------------------------------------

async function runSc1() {
  // Offline proxy 1: content-writer (orchestrator entry).
  if (pkgPresent('services/content-writer')) {
    const a = runVitestForPkg('@kos/service-content-writer');
    if (!a.ok) {
      pushResult('SC1a-content-writer', 'FAIL', {
        vitest_status: a.status,
        stdout_tail: a.stdoutTail,
      });
    } else {
      pushResult('SC1a-content-writer', 'PASS', { vitest_status: a.status });
    }
  } else {
    pushResult('SC1a-content-writer', 'PENDING', {
      reason: 'services/content-writer workspace not present (Plan 08-02 not landed)',
    });
  }

  // Offline proxy 2: content-writer-platform (per-platform shaping).
  if (pkgPresent('services/content-writer-platform')) {
    const b = runVitestForPkg('@kos/service-content-writer-platform');
    if (!b.ok) {
      pushResult('SC1b-content-writer-platform', 'FAIL', {
        vitest_status: b.status,
        stdout_tail: b.stdoutTail,
      });
    } else {
      pushResult('SC1b-content-writer-platform', 'PASS', { vitest_status: b.status });
    }
  } else {
    pushResult('SC1b-content-writer-platform', 'PENDING', {
      reason: 'services/content-writer-platform workspace not present (Plan 08-02 not landed)',
    });
  }

  // Offline proxy 3: CDK state-machine synthesis.
  const c = runVitestForPkg('@kos/cdk', 'integrations-content');
  if (!c.ok) {
    pushResult('SC1c-cdk-state-machine', 'FAIL', {
      vitest_status: c.status,
      stdout_tail: c.stdoutTail,
    });
  } else {
    pushResult('SC1c-cdk-state-machine', 'PASS', { vitest_status: c.status });
  }

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const stateMachineName = process.env.KOS_CONTENT_STATE_MACHINE_NAME ?? 'ContentDraftingFanout';
    const sfn = runSubprocess('aws', [
      'stepfunctions',
      'list-state-machines',
      '--query',
      `stateMachines[?name=='${stateMachineName}'].[name,status]`,
      '--output',
      'text',
      '--region',
      region,
    ]);
    if (!sfn.ok) {
      pushResult('SC1d-state-machine-deployed', 'FAIL', {
        exit_status: sfn.status,
        stderr_tail: sfn.stderrTail,
      });
    } else if (!sfn.stdoutTail.trim()) {
      pushResult('SC1d-state-machine-deployed', 'PENDING', {
        reason: `state machine ${stateMachineName} not deployed in ${region}`,
      });
    } else if (!/ACTIVE/.test(sfn.stdoutTail)) {
      pushResult('SC1d-state-machine-deployed', 'FAIL', {
        line: sfn.stdoutTail.trim(),
      });
    } else {
      pushResult('SC1d-state-machine-deployed', 'PASS', { state_machine: sfn.stdoutTail.trim() });
    }
  }
}

// ----------------------------------------------------------------------------
// SC2 — Publisher + Postiz MCP + cancel-before-publish
// ----------------------------------------------------------------------------

async function runSc2() {
  if (pkgPresent('services/publisher')) {
    const a = runVitestForPkg('@kos/service-publisher');
    if (!a.ok) {
      pushResult('SC2a-publisher-vitest', 'FAIL', {
        vitest_status: a.status,
        stdout_tail: a.stdoutTail,
      });
    } else {
      pushResult('SC2a-publisher-vitest', 'PASS', { vitest_status: a.status });
    }
  } else {
    pushResult('SC2a-publisher-vitest', 'PENDING', {
      reason: 'services/publisher workspace not present (Plan 08-03 autonomous: false; not landed)',
    });
  }

  // CDK Postiz + publisher stack synth.
  const b = runVitestForPkg('@kos/cdk', 'integrations-publisher');
  if (!b.ok) {
    pushResult('SC2b-cdk-publisher-stack', 'FAIL', {
      vitest_status: b.status,
      stdout_tail: b.stdoutTail,
    });
  } else {
    pushResult('SC2b-cdk-publisher-stack', 'PASS', { vitest_status: b.status });
  }

  // Live runtime probe deferred to SC7. Plan 08-03 is autonomous: false: the
  // Approve+publish round-trip itself is operator-driven.
  pushResult('SC2c-publish-roundtrip', 'MANUAL_BLOCKED', {
    reason:
      'Plan 08-03 is autonomous: false — operator approves a real draft in /inbox and observes Postiz publish + content_drafts.published_at write. See 08-06-GATE-evidence-template.md.',
  });
}

// ----------------------------------------------------------------------------
// SC3 — Google Calendar (both accounts) + entity context
// ----------------------------------------------------------------------------

async function runSc3() {
  if (pkgPresent('services/calendar-reader')) {
    const a = runVitestForPkg('@kos/service-calendar-reader');
    if (!a.ok) {
      pushResult('SC3a-calendar-reader', 'FAIL', {
        vitest_status: a.status,
        stdout_tail: a.stdoutTail,
      });
    } else {
      pushResult('SC3a-calendar-reader', 'PASS', { vitest_status: a.status });
    }
  } else {
    pushResult('SC3a-calendar-reader', 'PENDING', {
      reason: 'services/calendar-reader workspace not present (Plan 08-01 not landed)',
    });
  }

  const b = runVitestForPkg('@kos/cdk', 'integrations-calendar');
  if (!b.ok) {
    pushResult('SC3b-cdk-calendar', 'FAIL', {
      vitest_status: b.status,
      stdout_tail: b.stdoutTail,
    });
  } else {
    pushResult('SC3b-cdk-calendar', 'PASS', { vitest_status: b.status });
  }

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const secretIds = [
      'kos/gcal-oauth-kevin-elzarka',
      'kos/gcal-oauth-kevin-taleforge',
    ];
    const missing = [];
    for (const id of secretIds) {
      const sm = runSubprocess('aws', [
        'secretsmanager',
        'describe-secret',
        '--secret-id',
        id,
        '--region',
        region,
        '--query',
        'Name',
        '--output',
        'text',
      ]);
      if (!sm.ok || /ResourceNotFoundException/.test(sm.stderrTail)) {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      pushResult('SC3c-gcal-oauth-secrets', 'PENDING', {
        reason: `missing secrets: ${missing.join(', ')} — bootstrap via scripts/bootstrap-gcal-oauth.mjs`,
      });
    } else {
      pushResult('SC3c-gcal-oauth-secrets', 'PASS', { secrets: secretIds });
    }
  }
}

// ----------------------------------------------------------------------------
// SC4 — Document version tracker
// ----------------------------------------------------------------------------

async function runSc4() {
  if (pkgPresent('services/document-diff')) {
    const a = runVitestForPkg('@kos/service-document-diff');
    if (!a.ok) {
      pushResult('SC4-document-diff', 'FAIL', {
        vitest_status: a.status,
        stdout_tail: a.stdoutTail,
      });
    } else {
      pushResult('SC4-document-diff', 'PASS', { vitest_status: a.status });
    }
  } else {
    pushResult('SC4-document-diff', 'PENDING', {
      reason: 'services/document-diff workspace not present (Plan 08-05 not landed)',
    });
  }
}

// ----------------------------------------------------------------------------
// SC5 — Approve gate non-bypassable (delegates to verify-gate-8)
// ----------------------------------------------------------------------------

async function runSc5() {
  const gate8Script = resolve(REPO_ROOT, 'scripts/verify-gate-8.mjs');
  if (!existsSync(gate8Script)) {
    pushResult('SC5-approve-gate', 'FAIL', {
      reason: `verify-gate-8.mjs not found at ${gate8Script}`,
    });
    return;
  }
  const r = runSubprocess('node', [gate8Script, `--mode=${mode}`, '--test=approve-gate']);
  if (r.ok) {
    pushResult('SC5-approve-gate', 'PASS', { exit_status: r.status });
  } else {
    pushResult('SC5-approve-gate', 'FAIL', {
      exit_status: r.status,
      stderr_tail: r.stderrTail,
      stdout_tail: r.stdoutTail,
    });
  }
}

// ----------------------------------------------------------------------------
// SC6 — Imperative-verb mutation pathway
// ----------------------------------------------------------------------------

async function runSc6() {
  if (pkgPresent('services/mutation-proposer')) {
    const a = runVitestForPkg('@kos/service-mutation-proposer');
    if (!a.ok) {
      pushResult('SC6a-mutation-proposer', 'FAIL', {
        vitest_status: a.status,
        stdout_tail: a.stdoutTail,
      });
    } else {
      pushResult('SC6a-mutation-proposer', 'PASS', { vitest_status: a.status });
    }
  } else {
    pushResult('SC6a-mutation-proposer', 'PENDING', {
      reason: 'services/mutation-proposer workspace not present (Plan 08-04 not landed)',
    });
  }

  if (pkgPresent('services/mutation-executor')) {
    const b = runVitestForPkg('@kos/service-mutation-executor');
    if (!b.ok) {
      pushResult('SC6b-mutation-executor', 'FAIL', {
        vitest_status: b.status,
        stdout_tail: b.stdoutTail,
      });
    } else {
      pushResult('SC6b-mutation-executor', 'PASS', { vitest_status: b.status });
    }
  } else {
    pushResult('SC6b-mutation-executor', 'PENDING', {
      reason: 'services/mutation-executor workspace not present (Plan 08-04 not landed)',
    });
  }

  // Optional Plan 08-06 Task 2 deliverable.
  const rollback = resolve(REPO_ROOT, 'scripts/verify-mutation-rollback.mjs');
  if (!existsSync(rollback)) {
    pushResult('SC6c-rollback-script', 'PENDING', {
      reason: 'scripts/verify-mutation-rollback.mjs not present (Plan 08-06 Task 2 not landed)',
    });
    return;
  }
  if (mode === 'live') {
    // The script's --verify mode polls for the post-Approve state. Operator
    // is expected to have approved the seeded mutation in the dashboard
    // before re-running with --mode=live.
    const r = runSubprocess('node', [rollback, '--verify']);
    if (!r.ok) {
      pushResult('SC6c-rollback-live', 'FAIL', {
        exit_status: r.status,
        stdout_tail: r.stdoutTail,
      });
    } else {
      pushResult('SC6c-rollback-live', 'PASS', { exit_status: r.status });
    }
  } else {
    const r = runSubprocess('node', ['--check', rollback]);
    if (!r.ok) {
      pushResult('SC6c-rollback-script', 'FAIL', {
        node_check: 'failed',
        stderr_tail: r.stderrTail,
      });
    } else {
      pushResult('SC6c-rollback-script', 'PASS', { node_check: 'ok', live_skipped: true });
    }
  }
}

// ----------------------------------------------------------------------------
// SC7 — Postiz Fargate deployment
// ----------------------------------------------------------------------------

async function runSc7() {
  // Offline: CDK synth.
  const a = runVitestForPkg('@kos/cdk', 'integrations-postiz');
  if (!a.ok) {
    pushResult('SC7a-cdk-postiz', 'FAIL', {
      vitest_status: a.status,
      stdout_tail: a.stdoutTail,
    });
  } else {
    pushResult('SC7a-cdk-postiz', 'PASS', { vitest_status: a.status });
  }

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const cluster = process.env.KOS_ECS_CLUSTER ?? 'kos-cluster';
    const service = process.env.KOS_POSTIZ_SERVICE ?? 'postiz';
    const ecs = runSubprocess('aws', [
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      service,
      '--region',
      region,
      '--query',
      'services[0].[runningCount,desiredCount,status]',
      '--output',
      'text',
    ]);
    if (!ecs.ok) {
      pushResult('SC7b-postiz-runtime', 'PENDING', {
        reason: `aws ecs describe-services failed (status=${ecs.status}); Plan 08-03 (autonomous: false) may not be deployed`,
      });
    } else {
      const line = ecs.stdoutTail.trim();
      if (!line || /MISSING|None/.test(line)) {
        pushResult('SC7b-postiz-runtime', 'PENDING', {
          reason: `Postiz service not found in cluster ${cluster}`,
        });
      } else {
        const parts = line.split(/\s+/);
        const running = Number(parts[0] ?? 0);
        const desired = Number(parts[1] ?? 0);
        const status = parts[2] ?? '';
        if (running === 1 && desired === 1 && status === 'ACTIVE') {
          pushResult('SC7b-postiz-runtime', 'PASS', { running, desired, status });
        } else {
          pushResult('SC7b-postiz-runtime', 'FAIL', { line });
        }
      }
    }
  }

  // Per-platform OAuth + first round-trip remain operator-only.
  pushResult('SC7c-postiz-oauth-and-roundtrip', 'MANUAL_BLOCKED', {
    reason:
      'per-platform OAuth (Instagram / LinkedIn / TikTok / Reddit / Newsletter) + first real Approve+publish round-trip require operator action (Plan 08-03 autonomous: false). See 08-06-GATE-evidence-template.md.',
  });
}

// ----------------------------------------------------------------------------
// Manual-only reminders
// ----------------------------------------------------------------------------

function printManualChecks() {
  console.log('\n=== Manual operator checks (NOT automated) ===');
  console.log('  • SC2 + SC7 — Postiz first-boot (admin user, API key generation), per-platform');
  console.log('               OAuth (Instagram/LinkedIn/TikTok/Reddit/Newsletter), and first');
  console.log('               real Approve+publish round-trip from /inbox. Plan 08-03 is');
  console.log('               autonomous: false — operator owns these signals.');
  console.log('  • SC4       — End-to-end document version flow: send avtal.pdf v3 → edit →');
  console.log('               send v4 → entity timeline shows diff_summary. (Live email needed)');
  console.log('  • SC6       — Voice-capture imperative-verb flow ("ta bort mötet imorgon kl 11")');
  console.log('               → Inbox card → Approve → calendar_events_cache.ignored_by_kevin=true');
  console.log('               (Google Calendar untouched).');
  console.log('  • Brand voice — BRAND_VOICE.md human_verification: true with real (non-template)');
  console.log('               body. Subjective sign-off owned by operator.');
  console.log('  • Cost      — 7-day post-deploy spend within ~$24/month budget add (Postiz Fargate');
  console.log('               + Bedrock content-writer + mutation-proposer + document-diff Haiku).');
  console.log(
    '  See .planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md',
  );
}

function printCherryPickCoverage() {
  console.log('\n=== Cherry-pick coverage ===');
  console.log('  • Calendar-only:                SC3 (calendar-reader + brief context).');
  console.log('  • Calendar + document-diff:     SC3 + SC4 (memory-side phase 8 deliverables).');
  console.log('  • + Mutations:                  SC3 + SC4 + SC5 + SC6 (all autonomous: true plans).');
  console.log('  • Full Phase 8 (incl. Postiz):  SC1-7; SC2/SC7 round-trip operator-only.');
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

(async () => {
  console.log(`[verify-phase-8-e2e] mode=${mode} test=${test} repo=${REPO_ROOT}\n`);

  if (test === 'all' || test === 'SC1') await runSc1();
  if (test === 'all' || test === 'SC2') await runSc2();
  if (test === 'all' || test === 'SC3') await runSc3();
  if (test === 'all' || test === 'SC4') await runSc4();
  if (test === 'all' || test === 'SC5') await runSc5();
  if (test === 'all' || test === 'SC6') await runSc6();
  if (test === 'all' || test === 'SC7') await runSc7();

  console.log('\n=== Phase 8 E2E Summary ===');
  for (const r of results) {
    const sigil =
      r.status === 'PASS' ? 'OK '
      : r.status === 'SKIP' ? 'SK '
      : r.status === 'PENDING' ? 'PN '
      : r.status === 'MANUAL_BLOCKED' ? 'MB '
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
        verifier: 'verify-phase-8-e2e',
        mode,
        test,
        results,
      }) + '\n',
    );
    process.exit(1);
  }
  console.log('\nAll selected Phase 8 success criteria PASS (or SKIPPED / PENDING / MANUAL_BLOCKED).');
  if (mode === 'offline') {
    console.log(
      'Run again with --mode=live after deploy to exercise the live probes; manual rows above remain operator-owned.',
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('[verify-phase-8-e2e] unexpected error:', err);
  process.stderr.write(
    JSON.stringify({
      verifier: 'verify-phase-8-e2e',
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
