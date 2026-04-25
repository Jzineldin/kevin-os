#!/usr/bin/env node
/**
 * verify-phase-7-e2e.mjs — Phase 7 lifecycle-automation end-to-end gate.
 *
 * Mirror of scripts/verify-phase-6-e2e.mjs. Two modes:
 *
 *   --mock (default when AWS_REGION is unset OR --mock is passed)
 *     Pure offline integration: every Phase 7 surface is asserted via
 *     structural source checks. Zero AWS / Notion / Bedrock credentials
 *     needed; runs in <5s; safe for CI.
 *
 *     Asserted PASSES:
 *       1. Brief contracts present in @kos/contracts (Morning/DayClose/
 *          Weekly + BriefAgentRunOutput).
 *       2. services/morning-brief, services/day-close, services/weekly-review
 *          handlers exist and wire loadContext + writeTop3Membership +
 *          output.push to kos.output.
 *       3. services/verify-notification-cap handler + queries.ts present
 *          and wire SNS Publish + EventBridge brief.compliance_violation.
 *       4. Migration 0014 has top3_membership table + dropped_threads_v
 *          view + acted_on_at trigger.
 *       5. CDK integrations-lifecycle.ts wires 5 schedules:
 *            morning-brief-weekdays-08, day-close-weekdays-18,
 *            weekly-review-sun-19, email-triage-every-2h,
 *            verify-notification-cap-weekly.
 *       6. CDK schedule expressions cron-correct + Europe/Stockholm + OFF.
 *       7. Quiet-hours invariant pre-check: morning-brief schedule fires at
 *          08:00 (NOT 07:00 — D-18 drift documented).
 *       8. 14-day cap-verifier query + quiet-hours verifier present and
 *          syntactically valid.
 *       9. SNS publish + brief.compliance_violation wired in
 *          verify-notification-cap.
 *      10. CfnSchedule verify-notification-cap-weekly cron + Stockholm.
 *
 *   --live (requires AWS + DATABASE_URL)
 *     1. Confirm agent_runs has rows for morning-brief / day-close /
 *        weekly-review in the relevant time windows.
 *     2. Confirm top3_membership table populated for today.
 *     3. Run scripts/verify-notification-cap-14day.mjs as subprocess.
 *     4. Run scripts/verify-quiet-hours-invariant.mjs as subprocess.
 *
 * Exit codes:
 *   0 — every assertion PASSED
 *   1 — any assertion FAILED
 *
 * Usage:
 *   node scripts/verify-phase-7-e2e.mjs               # auto-mode
 *   node scripts/verify-phase-7-e2e.mjs --mock        # forced offline
 *   AWS_REGION=eu-north-1 DATABASE_URL=postgres://... \
 *     node scripts/verify-phase-7-e2e.mjs --live
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const forceMock = args.has('--mock');
const forceLive = args.has('--live');
const mode = forceLive
  ? 'live'
  : forceMock || !process.env.AWS_REGION
    ? 'mock'
    : 'live';

// ----------------------------------------------------------------------------
// Result tracking
// ----------------------------------------------------------------------------
const results = [];
function pass(label, detail) {
  results.push({ status: 'PASS', label, detail: detail ?? '' });
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail) {
  results.push({ status: 'FAIL', label, detail: detail ?? '' });
  console.error(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
}
function info(line) {
  console.log(`       ${line}`);
}
function readSource(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}
function exists(relPath) {
  return existsSync(resolve(REPO_ROOT, relPath));
}

// ----------------------------------------------------------------------------
// MOCK MODE
// ----------------------------------------------------------------------------

async function runMock() {
  console.log('Phase 7 E2E (mock mode)');
  console.log(`  repo=${REPO_ROOT}`);
  console.log('');

  // 1. Brief contracts in @kos/contracts.
  try {
    const briefSrc = readSource('packages/contracts/src/brief.ts');
    const required = [
      'MorningBriefSchema',
      'DayCloseBriefSchema',
      'WeeklyReviewSchema',
      'BriefAgentRunOutputSchema',
      'BriefCommonFieldsSchema',
    ];
    const missing = required.filter((s) => !briefSrc.includes(s));
    if (missing.length > 0) {
      throw new Error(`brief.ts missing exports: ${missing.join(', ')}`);
    }
    pass('@kos/contracts/brief: 5 schema exports present', required.join(', '));
  } catch (err) {
    fail('Brief contracts incomplete', err.message);
  }

  // 2. Morning-brief handler wires loadContext + writeTop3Membership + output.push.
  try {
    const handlerPath = 'services/morning-brief/src/handler.ts';
    if (!exists(handlerPath)) throw new Error(`${handlerPath} missing`);
    const txt = readSource(handlerPath);
    const probes = [
      ['loadContext', /loadContext\(/],
      ['writeTop3Membership', /writeTop3Membership\(/],
      ['EventBusName output', /OUTPUT_BUS_NAME|kos\.output/],
      ['DetailType output.push', /output\.push/],
      ['agent_runs success', /updateAgentRunSuccess/],
      ['ulid capture_id', /ulid\(\)/],
    ];
    for (const [label, rx] of probes) {
      if (!rx.test(txt)) throw new Error(`morning-brief missing ${label}`);
    }
    pass('morning-brief handler wires loadContext + top3 + output.push');
  } catch (err) {
    fail('morning-brief handler wiring incomplete', err.message);
  }

  // 3. Day-close handler wires the same shape + Kevin Context append.
  try {
    const handlerPath = 'services/day-close/src/handler.ts';
    if (!exists(handlerPath)) throw new Error(`${handlerPath} missing`);
    const txt = readSource(handlerPath);
    const probes = [
      ['loadContext', /loadContext\(/],
      ['writeTop3Membership', /writeTop3Membership\(/],
      ['output.push', /output\.push/],
      ['Kevin Context append', /appendKevinContextSections|NOTION_KEVIN_CONTEXT_PAGE_ID/],
    ];
    for (const [label, rx] of probes) {
      if (!rx.test(txt)) throw new Error(`day-close missing ${label}`);
    }
    pass('day-close handler wires loadContext + top3 + Kevin Context + output.push');
  } catch (err) {
    fail('day-close handler wiring incomplete', err.message);
  }

  // 4. Weekly-review handler wires loadContext + Active Threads replace + output.push.
  try {
    const handlerPath = 'services/weekly-review/src/handler.ts';
    if (!exists(handlerPath)) throw new Error(`${handlerPath} missing`);
    const txt = readSource(handlerPath);
    const probes = [
      ['loadContext', /loadContext\(/],
      ['Active Threads replace', /replaceActiveThreadsSection|active_threads_snapshot/],
      ['output.push', /output\.push/],
    ];
    for (const [label, rx] of probes) {
      if (!rx.test(txt)) throw new Error(`weekly-review missing ${label}`);
    }
    pass('weekly-review handler wires loadContext + active threads + output.push');
  } catch (err) {
    fail('weekly-review handler wiring incomplete', err.message);
  }

  // 5. verify-notification-cap handler wires SNS + brief.compliance_violation.
  try {
    const handlerPath = 'services/verify-notification-cap/src/handler.ts';
    const queriesPath = 'services/verify-notification-cap/src/queries.ts';
    if (!exists(handlerPath)) throw new Error(`${handlerPath} missing`);
    if (!exists(queriesPath)) throw new Error(`${queriesPath} missing`);
    const handler = readSource(handlerPath);
    const queries = readSource(queriesPath);
    const handlerProbes = [
      ['SNS PublishCommand', /PublishCommand/],
      ['SNSClient send', /sns\.send|new SNSClient/],
      ['brief.compliance_violation', /brief\.compliance_violation/],
      ['ALARM_TOPIC_ARN', /ALARM_TOPIC_ARN/],
      ['loadCapSnapshots14Days', /loadCapSnapshots14Days/],
      ['loadQuietHoursViolations14Days', /loadQuietHoursViolations14Days/],
    ];
    for (const [label, rx] of handlerProbes) {
      if (!rx.test(handler)) throw new Error(`verify-cap handler missing ${label}`);
    }
    if (!/14 days/.test(queries)) {
      throw new Error('verify-cap queries.ts missing 14-day window literal');
    }
    if (!/Europe\/Stockholm/.test(queries)) {
      throw new Error('verify-cap queries.ts missing Europe/Stockholm timezone');
    }
    if (!/CAP_PER_DAY|> 3|> CAP_PER_DAY/.test(queries)) {
      throw new Error('verify-cap queries.ts missing >3 cap threshold');
    }
    pass('verify-notification-cap wires SNS + brief.compliance_violation + 14d cap query');
  } catch (err) {
    fail('verify-notification-cap incomplete', err.message);
  }

  // 6. Migration 0014: top3_membership + dropped_threads_v + trigger.
  try {
    const sqlPath = 'packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql';
    if (!exists(sqlPath)) throw new Error(`${sqlPath} missing`);
    const sql = readSource(sqlPath);
    if (!/CREATE TABLE IF NOT EXISTS "?top3_membership"?/i.test(sql)) {
      throw new Error('top3_membership CREATE TABLE not found');
    }
    if (!/CREATE OR REPLACE VIEW\s+"?dropped_threads_v"?/i.test(sql)) {
      throw new Error('dropped_threads_v VIEW not found');
    }
    if (!/CREATE TRIGGER\s+\S+\s+AFTER INSERT ON\s+"?mention_events"?/i.test(sql)) {
      throw new Error('acted_on_at trigger on mention_events not found');
    }
    pass('Migration 0014 has top3_membership + dropped_threads_v + acted_on_at trigger');
  } catch (err) {
    fail('Migration 0014 incomplete', err.message);
  }

  // 7. CDK integrations-lifecycle.ts wires all 5 Phase 7 schedules.
  try {
    const cdkPath = 'packages/cdk/lib/stacks/integrations-lifecycle.ts';
    if (!exists(cdkPath)) throw new Error(`${cdkPath} missing`);
    const cdk = readSource(cdkPath);
    const schedules = [
      ['morning-brief-weekdays-08', /'morning-brief-weekdays-08'/],
      ['day-close-weekdays-18', /'day-close-weekdays-18'/],
      ['weekly-review-sun-19', /'weekly-review-sun-19'/],
      ['email-triage-every-2h', /'email-triage-every-2h'/],
      ['verify-notification-cap-weekly', /'verify-notification-cap-weekly'/],
    ];
    for (const [name, rx] of schedules) {
      if (!rx.test(cdk)) throw new Error(`schedule ${name} not present`);
    }
    pass('integrations-lifecycle.ts wires 5 Phase 7 schedules');
  } catch (err) {
    fail('integrations-lifecycle.ts schedules incomplete', err.message);
  }

  // 8. CDK schedule expressions cron-correct + Europe/Stockholm + OFF.
  try {
    const cdk = readSource('packages/cdk/lib/stacks/integrations-lifecycle.ts');
    const crons = [
      ['morning', /cron\(0 8 \? \* MON-FRI \*\)/],
      ['day-close', /cron\(0 18 \? \* MON-FRI \*\)/],
      ['weekly', /cron\(0 19 \? \* SUN \*\)/],
      ['email-triage', /cron\(0 8\/2 \? \* MON-FRI \*\)/],
      ['verify-cap', /cron\(0 3 \? \* SUN \*\)/],
    ];
    for (const [name, rx] of crons) {
      if (!rx.test(cdk)) throw new Error(`cron expression for ${name} not found`);
    }
    // Every CfnSchedule must use Europe/Stockholm timezone.
    const stockholmCount = (cdk.match(/Europe\/Stockholm/g) ?? []).length;
    if (stockholmCount < 5) {
      throw new Error(`expected ≥5 Europe/Stockholm refs, got ${stockholmCount}`);
    }
    // flexibleTimeWindow OFF on every CfnSchedule.
    const offCount = (cdk.match(/mode:\s*'OFF'/g) ?? []).length;
    if (offCount < 5) {
      throw new Error(`expected ≥5 flexibleTimeWindow OFF, got ${offCount}`);
    }
    pass('5 Phase 7 schedules: cron + Stockholm + OFF correct');
  } catch (err) {
    fail('CDK schedule expressions incomplete', err.message);
  }

  // 9. Quiet-hours invariant: morning-brief schedule at 08:00 (D-18).
  try {
    const cdk = readSource('packages/cdk/lib/stacks/integrations-lifecycle.ts');
    if (!/cron\(0 8 \? \* MON-FRI \*\)/.test(cdk)) {
      throw new Error('morning-brief NOT scheduled at 08:00 (D-18 drift expected)');
    }
    if (/cron\(0 7 \? \* MON-FRI \*\)/.test(cdk)) {
      throw new Error('morning-brief AT 07:00 — quiet-hours invariant would fail (must be 08:00 per D-18)');
    }
    pass('Quiet-hours invariant respected: morning-brief at 08:00 (D-18)');
  } catch (err) {
    fail('Quiet-hours invariant pre-check failed', err.message);
  }

  // 10. Verifier scripts present + syntactically valid.
  for (const script of [
    'scripts/verify-notification-cap-14day.mjs',
    'scripts/verify-quiet-hours-invariant.mjs',
  ]) {
    try {
      if (!exists(script)) throw new Error('script missing');
      execSync(`node --check ${resolve(REPO_ROOT, script)}`, { stdio: 'pipe' });
      pass(`${script} parses cleanly via node --check`);
    } catch (err) {
      fail(`${script} parse failure`, err.message ?? String(err));
    }
  }

  // 11. CfnSchedule verify-notification-cap-weekly target = Lambda function.
  try {
    const cdk = readSource('packages/cdk/lib/stacks/integrations-lifecycle.ts');
    if (!/'verify-notification-cap-weekly'/.test(cdk)) {
      throw new Error('verify-notification-cap-weekly not present');
    }
    if (!/cron\(0 3 \? \* SUN \*\)/.test(cdk)) {
      throw new Error('verify-cap cron not 0 3 ? * SUN *');
    }
    // Locate the verify-cap schedule block and verify it references the
    // verifyNotificationCap Lambda's functionArn (not a bus).
    const idx = cdk.indexOf("'verify-notification-cap-weekly'");
    const tail = cdk.slice(idx, idx + 1500);
    if (!/verifyNotificationCap\.functionArn/.test(tail)) {
      throw new Error('verify-cap schedule target is not verifyNotificationCap.functionArn');
    }
    pass('verify-notification-cap-weekly schedule targets the Lambda directly (not a bus)');
  } catch (err) {
    fail('verify-cap schedule wiring incomplete', err.message);
  }

  // 12. IAM grants on verify-cap Lambda: capTable read + alarmTopic publish.
  try {
    const cdk = readSource('packages/cdk/lib/stacks/integrations-lifecycle.ts');
    if (!/telegramCapTable\.grantReadData\(verifyNotificationCap\)/.test(cdk)) {
      throw new Error('telegramCapTable.grantReadData(verifyNotificationCap) missing');
    }
    if (!/alarmTopic\.grantPublish\(verifyNotificationCap\)/.test(cdk)) {
      throw new Error('alarmTopic.grantPublish(verifyNotificationCap) missing');
    }
    if (!/(systemBus\.grantPutEventsTo\(verifyNotificationCap\)|grantPutEventsTo\(verifyNotificationCap\))/.test(cdk)) {
      throw new Error('systemBus.grantPutEventsTo(verifyNotificationCap) missing');
    }
    pass('verify-cap IAM grants: capTable read + alarmTopic publish + system bus PutEvents');
  } catch (err) {
    fail('verify-cap IAM grants incomplete', err.message);
  }

  // ----------------------- Summary -----------------------
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('');
  console.log(`Result: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`);
  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  - ${r.label}: ${r.detail}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------
// LIVE MODE
// ----------------------------------------------------------------------------

async function runLive() {
  console.log('Phase 7 E2E (live mode)');
  const ownerId = process.env.KEVIN_OWNER_ID ?? '9e4be978-cc7d-571b-98ec-a1e92373682c';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[ERR] live mode requires DATABASE_URL env');
    process.exit(1);
  }
  console.log(`  owner_id=${ownerId}`);
  console.log('');

  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  // SC1 — morning-brief recorded in last 24h.
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE owner_id = $1 AND agent_name = 'morning-brief' AND status = 'ok'
          AND started_at > now() - interval '24 hours'`,
      [ownerId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) pass('SC1 morning-brief ran in last 24h', `n=${n}`);
    else fail('SC1 morning-brief did NOT run in last 24h', `n=${n}`);
  } catch (err) {
    fail('SC1 morning-brief query failed', err.message);
  }

  // SC2 — day-close recorded in last 30h.
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE owner_id = $1 AND agent_name = 'day-close' AND status = 'ok'
          AND started_at > now() - interval '30 hours'`,
      [ownerId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) pass('SC2 day-close ran in last 30h', `n=${n}`);
    else fail('SC2 day-close did NOT run in last 30h', `n=${n}`);
  } catch (err) {
    fail('SC2 day-close query failed', err.message);
  }

  // SC3 — weekly-review recorded in last 8 days.
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE owner_id = $1 AND agent_name = 'weekly-review' AND status = 'ok'
          AND started_at > now() - interval '8 days'`,
      [ownerId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) pass('SC3 weekly-review ran in last 8 days', `n=${n}`);
    else fail('SC3 weekly-review did NOT run in last 8 days', `n=${n}`);
  } catch (err) {
    fail('SC3 weekly-review query failed', err.message);
  }

  // SC4 — top3_membership rows for today (morning-brief wrote them).
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM top3_membership
        WHERE owner_id = $1
          AND brief_date = (now() AT TIME ZONE 'Europe/Stockholm')::date`,
      [ownerId],
    );
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) pass('SC4 top3_membership populated for today', `n=${n}`);
    else fail('SC4 top3_membership empty for today', `n=${n}`);
  } catch (err) {
    fail('SC4 top3_membership query failed', err.message);
  }

  await pool.end();

  // SC5 + SC6 — subprocess verifiers.
  for (const [name, cmd] of [
    ['SC5 cap invariant', `node ${resolve(REPO_ROOT, 'scripts/verify-notification-cap-14day.mjs')}`],
    ['SC6 quiet-hours invariant', `node ${resolve(REPO_ROOT, 'scripts/verify-quiet-hours-invariant.mjs')}`],
  ]) {
    try {
      execSync(cmd, { stdio: 'inherit' });
      pass(`${name} subprocess passed`);
    } catch (err) {
      fail(`${name} subprocess failed`, `exit ${err?.status ?? 'unknown'}`);
    }
  }

  // ----------------------- Summary -----------------------
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log('');
  console.log(`Result: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed})`);
  if (failed > 0) {
    console.log('Failures:');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  - ${r.label}: ${r.detail}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

console.log(`[verify-phase-7-e2e] mode=${mode}`);
console.log('');
if (mode === 'live') {
  await runLive();
} else {
  await runMock();
}
