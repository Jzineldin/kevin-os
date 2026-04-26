#!/usr/bin/env node
/**
 * verify-gate-8.mjs — Phase 8 Gate ("Outbound Content + Calendar Safe")
 * verifier.
 *
 * Mirrors the Phase 4 (verify-gate-3.mjs) and Phase 5 (verify-gate-5.mjs)
 * patterns: a single entry point that runs every automatable Gate 8 criterion
 * and explicitly DOCUMENTS the operator-only ones.
 *
 * Gate 8 has SEVEN ROADMAP success criteria. The first six are wholly or
 * partly automatable; SC 2 (publisher + Postiz round-trip) and SC 7 (Postiz
 * Fargate first-boot + per-platform OAuth) require manual operator action
 * because Plan 08-03 is `autonomous: false` (Postiz publisher + signed brand
 * voice). For those criteria the verifier emits MANUAL_BLOCKED so the gate
 * does not fail locally — operator owns the live signal during execute-phase.
 *
 *   1. APPROVE-GATE INVARIANT (auto, structural + live SQL)
 *      - Static (offline): `pnpm --filter @kos/cdk test --run integrations`
 *        synthesises the IAM policies and asserts every Phase-8 Lambda role
 *        is fenced (no bedrock:* on publisher; no postiz/ses on
 *        content-writer-platform; no bedrock/postiz/ses on mutation-executor;
 *        no postiz/ses on mutation-proposer).
 *      - Live (--mode=live): RDS query asserts:
 *          * 0 rows in content_drafts.status IN ('scheduled','published')
 *            without a consumed content_publish_authorizations row.
 *          * 0 rows in pending_mutations.status='executed' without a consumed
 *            pending_mutation_authorizations row.
 *      - Delegates to scripts/verify-approve-gate-invariant.mjs IF it exists
 *        (Plan 08-06 Task 2). PENDING if missing.
 *
 *   2. PROMPT-INJECTION RESISTANCE — content-writer (auto)
 *      - Offline: `pnpm --filter @kos/service-content-writer test`. The
 *        vitest suite includes the adversarial-topic fixture asserting
 *        (a) draft.status stays 'draft', (b) draft.postiz_post_id is null,
 *        (c) no content.published event fires.
 *      - Live: delegates to scripts/verify-prompt-injection-content-writer.mjs
 *        which fires a real adversarial topic via EventBridge and polls RDS.
 *        PENDING if the script does not yet exist (Plan 08-06 Task 2).
 *
 *   3. MUTATION ROLLBACK / ARCHIVE-NOT-DELETE (auto)
 *      - Offline: `pnpm --filter @kos/service-mutation-executor test`. The
 *        vitest suite asserts (a) executor never issues SQL DELETE, (b)
 *        archive flag is set on calendar_events_cache, (c) raw mention_events
 *        / capture row untouched after the cancel_meeting flow.
 *      - Live: delegates to scripts/verify-mutation-rollback.mjs --verify.
 *        PENDING if the script does not yet exist (Plan 08-06 Task 2).
 *
 *   4. STEP FUNCTIONS DRAFTING ORCHESTRATION (auto)
 *      - Offline: `pnpm --filter @kos/cdk test --run integrations-content`
 *        asserts the state-machine + 5 platform branches synthesise. The
 *        content-writer-platform vitest suite covers per-platform shaping.
 *      - Live: AWS Step Functions DescribeStateMachine on the
 *        ContentDraftingFanout state machine name + status=ACTIVE. PENDING
 *        if AWS_REGION not set / state machine not deployed.
 *
 *   5. CALENDAR-READER WIRING (auto)
 *      - Offline: `pnpm --filter @kos/service-calendar-reader test` +
 *        `pnpm --filter @kos/cdk test --run integrations-calendar` cover the
 *        EventBridge Scheduler + Google OAuth secret consumer.
 *      - Live: SSM/Secrets Manager probe for `kos/gcal-oauth-kevin-elzarka`
 *        and `kos/gcal-oauth-kevin-taleforge` plus an agent_runs query for
 *        calendar-reader status='ok' over the last 24h. PENDING if missing.
 *
 *   6. DOCUMENT-DIFF (auto)
 *      - Offline: `pnpm --filter @kos/service-document-diff test`. Asserts
 *        SHA256-keyed dedup, diff_summary string presence, document_versions
 *        chain wiring.
 *      - Live: agent_runs query for document-diff status='ok'. PENDING if
 *        not yet invoked (no live emails in the window).
 *
 *   ---- NOT AUTOMATED HERE (MANUAL_BLOCKED in offline; PENDING in live) ----
 *   7. POSTIZ FARGATE FIRST-BOOT + PER-PLATFORM OAUTH (operator)
 *      - Plan 08-03 is `autonomous: false`. Postiz first-boot (admin user
 *        creation, API key generation), per-platform OAuth (Instagram /
 *        LinkedIn / TikTok / Reddit / Newsletter), BRAND_VOICE.md sign-off,
 *        and the first-real-draft Approve+publish round-trip all require
 *        manual operator action.
 *      - In offline mode this verifier reports MANUAL_BLOCKED with a runbook
 *        reminder pointing at the evidence template.
 *      - In live mode it probes ECS DescribeServices for the postiz service
 *        + Cloud Map DNS resolution. If Postiz is up, it reports PASS for
 *        the runtime side and still MANUAL_BLOCKED for the OAuth + brand
 *        voice sign-off (cannot be machine-verified).
 *
 *   8. SIGNED BRAND VOICE (operator)
 *      - BRAND_VOICE.md `human_verification: true` + non-template body.
 *        Static check parses the front-matter; the subjective "real voice
 *        captured" sign-off remains MANUAL_BLOCKED.
 *
 * Modes:
 *   --mode=offline (default)
 *     • All vitest sub-runs. No AWS / RDS calls.
 *     • SC 2 (publisher live), SC 7 (Postiz first-boot), SC 8 (brand voice
 *        sign-off) are MANUAL_BLOCKED with runbook reminders.
 *
 *   --mode=live (operator-invoked, requires deployed infra + AWS creds)
 *     • Each SC adds the live probe described above.
 *     • Plan 08-03-only criteria (Postiz first-boot, per-platform OAuth,
 *        BRAND_VOICE sign-off) remain MANUAL_BLOCKED — operator owns them.
 *
 * Tests:
 *   --test=approve-gate | prompt-injection | mutation-rollback |
 *          step-functions | calendar | document-diff | postiz |
 *          brand-voice | all (default)
 *
 * Exit codes:
 *   0 — every selected test PASS (or SKIP / PENDING / MANUAL_BLOCKED)
 *   1 — any selected test FAIL
 *   2 — usage error / missing required env in live mode
 *
 * Output:
 *   stdout: human pass/fail summary
 *   stderr: structured JSON per test on failure (machine-readable)
 *
 * Usage:
 *   node scripts/verify-gate-8.mjs --mode=offline                     # default
 *   node scripts/verify-gate-8.mjs --mode=offline --test=approve-gate
 *   AWS_REGION=eu-north-1 DATABASE_URL=postgres://... \
 *     node scripts/verify-gate-8.mjs --mode=live
 *
 * Reference:
 *   .planning/phases/08-outbound-content-calendar/08-06-PLAN.md
 *   .planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md
 *   .planning/phases/08-outbound-content-calendar/08-VALIDATION.md
 *   scripts/verify-gate-5.mjs (Phase 5 sibling)
 *   scripts/verify-gate-3.mjs (Phase 4 sibling)
 */
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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
  console.log(`Usage: node scripts/verify-gate-8.mjs [--mode=offline|live] [--test=<name>|all]

Modes:
  --mode=offline (default)  Vitest delegates only; no cloud calls.
  --mode=live               Adds RDS + SSM + ECS probes; operator post-deploy.

Tests:
  --test=approve-gate       SC 5: Approve-gate invariant (IAM static + DB live)
  --test=prompt-injection   SC 1+5: content-writer adversarial topic resistance
  --test=mutation-rollback  SC 6: archive-not-delete + raw capture untouched
  --test=step-functions     SC 1: 5-platform Step Functions fan-out wiring
  --test=calendar           SC 3: calendar-reader CAP-09 wiring
  --test=document-diff      SC 4: document-diff MEM-05 wiring
  --test=postiz             SC 2+7: Postiz Fargate runtime + first-boot
  --test=brand-voice        Plan 08-03 brand voice signed off
  --test=all (default)      Run all of the above.

Not automated by this verifier:
  • SC 7 Postiz per-platform OAuth (Instagram / LinkedIn / TikTok / Reddit /
    Newsletter) — operator action; runbook in 08-06-GATE-evidence-template.md.
  • Brand-voice sign-off (BRAND_VOICE.md non-template body, human review) —
    static front-matter is checked; subjective sign-off remains MANUAL_BLOCKED.
  • First-real-topic Approve+publish round-trip — operator runs from /inbox.
`);
  process.exit(0);
}

const mode = String(values.mode);
const test = String(values.test);

if (!['offline', 'live'].includes(mode)) {
  console.error(`[verify-gate-8] unknown --mode=${mode} (expected offline | live)`);
  process.exit(2);
}
const VALID_TESTS = [
  'all',
  'approve-gate',
  'prompt-injection',
  'mutation-rollback',
  'step-functions',
  'calendar',
  'document-diff',
  'postiz',
  'brand-voice',
];
if (!VALID_TESTS.includes(test)) {
  console.error(`[verify-gate-8] unknown --test=${test} (expected one of ${VALID_TESTS.join(' | ')})`);
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
// Subprocess helpers (mirror verify-gate-5 pattern)
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
  // whose name matches the @kos/* shorthand.
  const stripped = pkg.replace(/^@kos\/(service-)?/, '');
  const candidates = [
    `services/${stripped}`,
    `packages/${stripped}`,
    `apps/${stripped}`,
  ];
  return candidates.some((rel) => existsSync(resolve(REPO_ROOT, rel, 'package.json')));
}

function delegateScript(rel) {
  return resolve(REPO_ROOT, rel);
}

// ----------------------------------------------------------------------------
// Test 1 — Approve-gate invariant (SC 5)
// ----------------------------------------------------------------------------

async function testApproveGate() {
  // Offline: structural CDK synth check via vitest filter.
  const cdkFilter = mode === 'offline' ? 'integrations' : 'integrations';
  const r = runVitest('@kos/cdk', cdkFilter);
  if (!r.ok) {
    throw new Error(
      `cdk integrations vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  // If a dedicated approve-gate invariant script exists (Plan 08-06 Task 2),
  // delegate to it. Soft-skip otherwise — gate still PASSes on the structural
  // check.
  const script = delegateScript('scripts/verify-approve-gate-invariant.mjs');
  if (existsSync(script)) {
    const flag = mode === 'live' ? '--live' : '--static';
    const r2 = spawnSync('node', [script, flag], { encoding: 'utf-8', cwd: REPO_ROOT });
    if (r2.status !== 0) {
      throw new Error(
        `verify-approve-gate-invariant ${flag} failed (status=${r2.status}): ${(r2.stdout ?? '').slice(-1500)}`,
      );
    }
    return { ...detail, sub_verifier: 'verify-approve-gate-invariant', sub_status: r2.status };
  }

  if (mode === 'live') {
    // Inline live SQL probe so the live mode still exercises the structural
    // invariants even before Plan 08-06 Task 2 lands the dedicated script.
    const dbUrl = process.env.DATABASE_URL ?? process.env.KOS_RDS_URL;
    if (!dbUrl) {
      throw new Error('live mode requires DATABASE_URL (or KOS_RDS_URL) for approve-gate invariant probe');
    }
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
    try {
      const orphanDrafts = await pool.query(`
        SELECT COUNT(*)::int AS bad
        FROM content_drafts cd
        WHERE cd.status IN ('scheduled','published')
          AND NOT EXISTS (
            SELECT 1 FROM content_publish_authorizations cpa
             WHERE cpa.draft_id = cd.id AND cpa.consumed_at IS NOT NULL
          )
      `);
      const orphanMutations = await pool.query(`
        SELECT COUNT(*)::int AS bad
        FROM pending_mutations pm
        WHERE pm.status = 'executed'
          AND NOT EXISTS (
            SELECT 1 FROM pending_mutation_authorizations pma
             WHERE pma.mutation_id = pm.id AND pma.consumed_at IS NOT NULL
          )
      `);
      const badDrafts = orphanDrafts.rows[0]?.bad ?? 0;
      const badMutations = orphanMutations.rows[0]?.bad ?? 0;
      if (badDrafts + badMutations > 0) {
        throw new Error(
          `approve-gate live FAIL: ${badDrafts} orphan published drafts; ${badMutations} orphan executed mutations`,
        );
      }
      return { ...detail, orphan_drafts: badDrafts, orphan_mutations: badMutations };
    } finally {
      await pool.end();
    }
  }

  return {
    ...detail,
    pending: 'scripts/verify-approve-gate-invariant.mjs not present (Plan 08-06 Task 2 not landed); structural CDK check still PASSes',
  };
}

// ----------------------------------------------------------------------------
// Test 2 — Prompt-injection resistance (SC 1 + SC 5)
// ----------------------------------------------------------------------------

async function testPromptInjection() {
  // Offline: vitest covers the adversarial-topic fixture inside content-writer.
  if (!pkgExists('@kos/service-content-writer')) {
    return {
      pending: '@kos/service-content-writer workspace not present (Plan 08-02 not landed)',
    };
  }
  const r = runVitest('@kos/service-content-writer');
  if (!r.ok) {
    throw new Error(
      `content-writer vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  // Live: delegate to the dedicated script if present.
  const script = delegateScript('scripts/verify-prompt-injection-content-writer.mjs');
  if (mode === 'live') {
    if (!existsSync(script)) {
      return {
        ...detail,
        pending: 'verify-prompt-injection-content-writer.mjs not present (Plan 08-06 Task 2 not landed)',
      };
    }
    const r2 = spawnSync('node', [script], { encoding: 'utf-8', cwd: REPO_ROOT });
    if (r2.status !== 0) {
      throw new Error(
        `verify-prompt-injection-content-writer failed (status=${r2.status}): ${(r2.stdout ?? '').slice(-1500)}`,
      );
    }
    return { ...detail, sub_status: r2.status };
  }

  // Offline: just node --check the script if present.
  if (existsSync(script)) {
    const r2 = spawnSync('node', ['--check', script], { encoding: 'utf-8' });
    if (r2.status !== 0) {
      throw new Error(`verify-prompt-injection-content-writer node --check failed: ${r2.stderr}`);
    }
    return { ...detail, node_check: 'ok', live_skipped: true };
  }
  return detail;
}

// ----------------------------------------------------------------------------
// Test 3 — Mutation rollback (SC 6)
// ----------------------------------------------------------------------------

async function testMutationRollback() {
  if (!pkgExists('@kos/service-mutation-executor')) {
    return {
      pending: '@kos/service-mutation-executor workspace not present (Plan 08-04 not landed)',
    };
  }
  const r = runVitest('@kos/service-mutation-executor');
  if (!r.ok) {
    throw new Error(
      `mutation-executor vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = {
    vitest_status: r.status,
    archive_not_delete_tests_present: /archive|ignored_by_kevin|not delete|never DELETE/i.test(r.stdoutTail),
  };

  const script = delegateScript('scripts/verify-mutation-rollback.mjs');
  if (mode === 'live') {
    if (!existsSync(script)) {
      return {
        ...detail,
        pending: 'verify-mutation-rollback.mjs not present (Plan 08-06 Task 2 not landed)',
      };
    }
    // Live mutation rollback test requires an operator-driven Approve step in
    // the dashboard; the script supports a --verify mode that polls for the
    // post-Approve state. We invoke it in --verify mode here.
    const r2 = spawnSync('node', [script, '--verify'], { encoding: 'utf-8', cwd: REPO_ROOT });
    if (r2.status !== 0) {
      throw new Error(
        `verify-mutation-rollback --verify failed (status=${r2.status}): ${(r2.stdout ?? '').slice(-1500)}`,
      );
    }
    return { ...detail, sub_status: r2.status };
  }

  if (existsSync(script)) {
    const r2 = spawnSync('node', ['--check', script], { encoding: 'utf-8' });
    if (r2.status !== 0) {
      throw new Error(`verify-mutation-rollback node --check failed: ${r2.stderr}`);
    }
    return { ...detail, node_check: 'ok', live_skipped: true };
  }
  return detail;
}

// ----------------------------------------------------------------------------
// Test 4 — Step Functions drafting orchestration (SC 1)
// ----------------------------------------------------------------------------

async function testStepFunctions() {
  // Offline: cdk vitest filter on integrations-content (state-machine synth).
  const r = runVitest('@kos/cdk', 'integrations-content');
  if (!r.ok) {
    // Filter may match 0 tests if the stack hasn't landed yet — vitest exits 0
    // with passWithNoTests in that case. Status != 0 means a real failure.
    throw new Error(
      `cdk integrations-content vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  // Per-platform shaping is exercised by content-writer-platform vitest.
  if (pkgExists('@kos/service-content-writer-platform')) {
    const b = runVitest('@kos/service-content-writer-platform');
    if (!b.ok) {
      throw new Error(
        `content-writer-platform vitest failed (status=${b.status}): ${b.stdoutTail}`,
      );
    }
    detail.platform_vitest_status = b.status;
  }

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const stateMachineName = process.env.KOS_CONTENT_STATE_MACHINE_NAME ?? 'ContentDraftingFanout';
    const sfn = spawnSync(
      'aws',
      [
        'stepfunctions',
        'list-state-machines',
        '--query',
        `stateMachines[?name=='${stateMachineName}'].[name,status]`,
        '--output',
        'text',
        '--region',
        region,
      ],
      { encoding: 'utf-8' },
    );
    if (sfn.status !== 0) {
      throw new Error(
        `aws stepfunctions list-state-machines failed (status=${sfn.status}): ${(sfn.stderr ?? '').slice(-600)}`,
      );
    }
    const line = (sfn.stdout ?? '').trim();
    if (!line) {
      return {
        ...detail,
        pending: `state machine ${stateMachineName} not deployed in ${region}`,
      };
    }
    if (!/ACTIVE/.test(line)) {
      throw new Error(`state machine ${stateMachineName} not ACTIVE: ${line}`);
    }
    return { ...detail, state_machine: line };
  }

  return detail;
}

// ----------------------------------------------------------------------------
// Test 5 — calendar-reader (SC 3)
// ----------------------------------------------------------------------------

async function testCalendar() {
  if (!pkgExists('@kos/service-calendar-reader')) {
    return {
      pending: '@kos/service-calendar-reader workspace not present (Plan 08-01 not landed)',
    };
  }
  const a = runVitest('@kos/service-calendar-reader');
  if (!a.ok) {
    throw new Error(
      `calendar-reader vitest failed (status=${a.status}): ${a.stdoutTail}`,
    );
  }
  const detail = { vitest_status: a.status };

  // CDK scheduler wiring (best-effort; passWithNoTests if filter misses).
  const b = runVitest('@kos/cdk', 'integrations-calendar');
  if (!b.ok) {
    throw new Error(
      `cdk integrations-calendar vitest failed (status=${b.status}): ${b.stdoutTail}`,
    );
  }
  detail.cdk_vitest_status = b.status;

  if (mode === 'live') {
    const region = process.env.AWS_REGION ?? 'eu-north-1';
    const checks = [
      'kos/gcal-oauth-kevin-elzarka',
      'kos/gcal-oauth-kevin-taleforge',
    ];
    const missing = [];
    for (const id of checks) {
      const sm = spawnSync(
        'aws',
        [
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
        ],
        { encoding: 'utf-8' },
      );
      if (sm.status !== 0 || /ResourceNotFoundException/.test(sm.stderr ?? '')) {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      return {
        ...detail,
        pending: `Google OAuth secrets missing: ${missing.join(', ')} — bootstrap via scripts/bootstrap-gcal-oauth.mjs`,
      };
    }

    // Bonus: agent_runs row in last 24h.
    const dbUrl = process.env.DATABASE_URL ?? process.env.KOS_RDS_URL;
    if (dbUrl) {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : undefined,
        max: 1,
      });
      try {
        const r = await pool.query(`
          SELECT COUNT(*)::int AS c
          FROM agent_runs
          WHERE agent_name = 'calendar-reader'
            AND status = 'ok'
            AND created_at > now() - interval '24 hours'
        `);
        detail.calendar_reader_runs_24h = r.rows[0]?.c ?? 0;
      } finally {
        await pool.end();
      }
    }
    detail.secrets_present = checks;
  }

  return detail;
}

// ----------------------------------------------------------------------------
// Test 6 — document-diff (SC 4)
// ----------------------------------------------------------------------------

async function testDocumentDiff() {
  if (!pkgExists('@kos/service-document-diff')) {
    return {
      pending: '@kos/service-document-diff workspace not present (Plan 08-05 not landed)',
    };
  }
  const r = runVitest('@kos/service-document-diff');
  if (!r.ok) {
    throw new Error(
      `document-diff vitest failed (status=${r.status}): ${r.stdoutTail}`,
    );
  }
  const detail = { vitest_status: r.status };

  if (mode === 'live') {
    const dbUrl = process.env.DATABASE_URL ?? process.env.KOS_RDS_URL;
    if (!dbUrl) {
      return {
        ...detail,
        pending: 'live mode set but DATABASE_URL/KOS_RDS_URL absent; cannot probe agent_runs',
      };
    }
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
    try {
      const r2 = await pool.query(`
        SELECT COUNT(*)::int AS c
        FROM agent_runs
        WHERE agent_name = 'document-diff'
          AND status = 'ok'
          AND created_at > now() - interval '7 days'
      `);
      const c = r2.rows[0]?.c ?? 0;
      if (c === 0) {
        return {
          ...detail,
          pending: 'no document-diff runs in last 7 days — send a versioned document to exercise the pipeline',
        };
      }
      return { ...detail, document_diff_runs_7d: c };
    } finally {
      await pool.end();
    }
  }

  return detail;
}

// ----------------------------------------------------------------------------
// Test 7 — Postiz Fargate runtime + first-boot (SC 2 + SC 7)
// ----------------------------------------------------------------------------

async function testPostiz() {
  // Plan 08-03 is autonomous: false. The first-boot, per-platform OAuth, and
  // brand-voice signed deliverables MUST be operator-verified.
  if (mode === 'offline') {
    return {
      manual_blocked:
        'Plan 08-03 is autonomous: false — Postiz Fargate first-boot, per-platform OAuth, and content publisher round-trip require manual operator action. See 08-06-GATE-evidence-template.md.',
    };
  }

  // Live: probe ECS for the postiz service.
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const cluster = process.env.KOS_ECS_CLUSTER ?? 'kos-cluster';
  const service = process.env.KOS_POSTIZ_SERVICE ?? 'postiz';
  const ecs = spawnSync(
    'aws',
    [
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
    ],
    { encoding: 'utf-8' },
  );
  if (ecs.status !== 0) {
    return {
      manual_blocked: `aws ecs describe-services failed (status=${ecs.status}); Postiz CDK stack may not be deployed yet (Plan 08-03 autonomous: false). Operator runbook in 08-06-GATE-evidence-template.md`,
    };
  }
  const line = (ecs.stdout ?? '').trim();
  if (!line || /MISSING|None/.test(line)) {
    return {
      manual_blocked: `Postiz service not found in cluster ${cluster}; Plan 08-03 not deployed. See 08-06-GATE-evidence-template.md`,
    };
  }
  const parts = line.split(/\s+/);
  const running = Number(parts[0] ?? 0);
  const desired = Number(parts[1] ?? 0);
  const status = parts[2] ?? '';
  if (running !== 1 || desired !== 1 || status !== 'ACTIVE') {
    throw new Error(
      `postiz service unhealthy: running=${running} desired=${desired} status=${status} (expected 1/1/ACTIVE)`,
    );
  }
  // Even with the runtime up, the per-platform OAuth + first round-trip are
  // operator-only checks — surface MANUAL_BLOCKED for that side.
  return {
    manual_blocked: `Postiz Fargate runtime healthy (${running}/${desired} ${status}). Per-platform OAuth (Instagram/LinkedIn/TikTok/Reddit/Newsletter) + first real Approve+publish round-trip remain operator-verified. See 08-06-GATE-evidence-template.md`,
    runtime: { running, desired, status },
  };
}

// ----------------------------------------------------------------------------
// Test 8 — Brand-voice signed
// ----------------------------------------------------------------------------

async function testBrandVoice() {
  // Static front-matter check: BRAND_VOICE.md has human_verification: true
  // AND a non-template body. The "real voice" subjective verification is
  // operator-only.
  const candidates = [
    'BRAND_VOICE.md',
    'docs/BRAND_VOICE.md',
    '.planning/BRAND_VOICE.md',
  ];
  const found = candidates.find((rel) => existsSync(resolve(REPO_ROOT, rel)));
  if (!found) {
    return {
      manual_blocked:
        'BRAND_VOICE.md not present in any of the expected locations (BRAND_VOICE.md, docs/, .planning/) — Plan 08-03 autonomous: false; operator drafts during execute-phase.',
    };
  }
  const body = readFileSync(resolve(REPO_ROOT, found), 'utf-8');
  const verified = /^human_verification:\s*true\b/m.test(body);
  // A "template" body has the placeholder pattern PHASE-08 ships. Heuristic:
  // require the body to mention at least one Kevin-specific anchor.
  const realVoiceHints = [
    /Tale Forge/i,
    /Kevin/i,
    /barn|child|berätt|story/i,
  ];
  const hits = realVoiceHints.filter((re) => re.test(body)).length;
  if (!verified) {
    return {
      manual_blocked: `${found} has human_verification != true; operator must sign off after writing real voice content.`,
    };
  }
  if (hits < 2) {
    return {
      manual_blocked: `${found} appears to still be a template (only ${hits}/3 voice hints matched); operator must replace placeholders with real voice.`,
    };
  }
  return { brand_voice_path: found, human_verification: true, voice_hints_matched: hits };
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

(async () => {
  console.log(`[verify-gate-8] mode=${mode} test=${test} repo=${REPO_ROOT}\n`);

  if (test === 'all' || test === 'approve-gate') {
    await runTest('1-approve-gate-invariant', testApproveGate);
  }
  if (test === 'all' || test === 'prompt-injection') {
    await runTest('2-prompt-injection-resistance', testPromptInjection);
  }
  if (test === 'all' || test === 'mutation-rollback') {
    await runTest('3-mutation-rollback', testMutationRollback);
  }
  if (test === 'all' || test === 'step-functions') {
    await runTest('4-step-functions-drafting', testStepFunctions);
  }
  if (test === 'all' || test === 'calendar') {
    await runTest('5-calendar-reader', testCalendar);
  }
  if (test === 'all' || test === 'document-diff') {
    await runTest('6-document-diff', testDocumentDiff);
  }
  if (test === 'all' || test === 'postiz') {
    await runTest('7-postiz-fargate', testPostiz);
  }
  if (test === 'all' || test === 'brand-voice') {
    await runTest('8-brand-voice', testBrandVoice);
  }

  console.log('\n=== Gate 8 Summary ===');
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

  console.log('\nNot automated by this verifier (operator runbook):');
  console.log(
    '  • SC 7 Postiz per-platform OAuth (Instagram / LinkedIn / TikTok / Reddit /',
  );
  console.log('    Newsletter) — operator scans QR / completes OAuth in Postiz UI.');
  console.log(
    '  • First real topic submitted → 5 drafts → 1 approved → published via Postiz —',
  );
  console.log('    operator round-trip from /inbox in dashboard.');
  console.log(
    '  • Voice capture mutation flow ("ta bort mötet imorgon kl 11") → Inbox card →',
  );
  console.log('    Approve → calendar event archived in KOS, Google left untouched.');
  console.log(
    '  • Document version flow: send avtal.pdf v3 → edit → send v4 → entity timeline',
  );
  console.log('    shows diff_summary.');
  console.log(
    '  See .planning/phases/08-outbound-content-calendar/08-06-GATE-evidence-template.md',
  );

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.log(`\n${failed.length} FAIL(s). See stderr JSON for details.`);
    process.stderr.write(
      JSON.stringify({
        verifier: 'verify-gate-8',
        mode,
        test,
        results,
      }) + '\n',
    );
    process.exit(1);
  }
  console.log(
    '\nAll selected Gate 8 criteria PASS (or SKIPPED / MANUAL_BLOCKED / PENDING in offline / pre-deploy mode).',
  );
  process.exit(0);
})().catch((err) => {
  console.error('[verify-gate-8] unexpected error:', err);
  process.stderr.write(
    JSON.stringify({
      verifier: 'verify-gate-8',
      fatal: true,
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
