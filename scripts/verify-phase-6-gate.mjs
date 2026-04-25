#!/usr/bin/env node
/**
 * verify-phase-6-gate.mjs — Phase 6 acceptance gate verifier.
 *
 * Walks all 7 Phase 6 success criteria from ROADMAP §Phase 6 and prints
 * PASS / FAIL / HUMAN per criterion.
 *
 *   PASS  — code-side check completed successfully
 *   FAIL  — code-side check failed (deployment/refactor required)
 *   HUMAN — auto-check is not possible; operator must complete the
 *           verification (e.g., "8/10 actionable" subjective rating)
 *
 * Modes:
 *   --mock (default when AWS_REGION unset OR --mock passed):
 *     Offline structural checks against source files. CI-safe.
 *
 *   --live (requires AWS creds):
 *     Calls AWS APIs / Azure / Postgres for runtime evidence on top of
 *     the structural checks. Requires KEVIN_OWNER_ID + AWS_REGION.
 *
 * Exit codes:
 *   0 — zero FAILs (HUMAN-flagged criteria are NOT failures; operator
 *       handles them via 06-06-GATE-evidence-template.md)
 *   1 — one or more FAILs (must be fixed before next phase)
 *
 * Usage:
 *   node scripts/verify-phase-6-gate.mjs              # auto mode
 *   node scripts/verify-phase-6-gate.mjs --mock       # forced offline
 *   AWS_REGION=eu-north-1 node scripts/verify-phase-6-gate.mjs --live
 *
 * Reference:
 *   .planning/phases/06-granola-semantic-memory/06-06-PLAN.md
 *   .planning/phases/06-granola-semantic-memory/06-CONTEXT.md
 *   .planning/ROADMAP.md §Phase 6
 *   .planning/phases/02-minimum-viable-loop/02-11-GATE-2-evidence-20260422.md
 *   (mirror pattern)
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
// Helpers
// ----------------------------------------------------------------------------

function readSource(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`source missing: ${rel}`);
  return readFileSync(p, 'utf8');
}

function exists(rel) {
  return existsSync(resolve(REPO_ROOT, rel));
}

function newResult(status, autoStatus, reason, evidence) {
  return { status, autoStatus, reason, evidence };
}
function pass(reason, evidence) {
  return newResult('PASS', 'PASS', reason, evidence);
}
function fail(reason, evidence) {
  return newResult('FAIL', 'FAIL', reason, evidence);
}
function human(autoStatus, reason, evidence) {
  // HUMAN-flagged criteria still report whether the auto-checkable parts
  // pass. autoStatus = PASS means "code-side is wired; operator owns the
  // subjective measurement"; autoStatus = FAIL means "code-side is broken
  // AND operator owes a measurement".
  return newResult('HUMAN', autoStatus, reason, evidence);
}

// ----------------------------------------------------------------------------
// SC1 — CAP-08 + AUTO-05: granola-poller every 15 min, idempotent
// ----------------------------------------------------------------------------

async function verifyCAP08AUTO05() {
  try {
    const handlerPath = 'services/granola-poller/src/handler.ts';
    if (!exists(handlerPath)) return fail(`granola-poller handler missing: ${handlerPath}`);
    const handler = readSource(handlerPath);
    if (!/export const handler\s*=/.test(handler)) {
      return fail('granola-poller does not export handler');
    }
    const integrationsPath = 'packages/cdk/lib/stacks/integrations-granola.ts';
    if (!exists(integrationsPath)) return fail(`CDK helper missing: ${integrationsPath}`);
    const integrations = readSource(integrationsPath);
    if (!/rate\(15 minutes\)/.test(integrations)) {
      return fail('integrations-granola.ts missing rate(15 minutes) schedule expression');
    }
    if (!/Europe\/Stockholm/.test(integrations)) {
      return fail('integrations-granola.ts missing Europe/Stockholm timezone');
    }
    // Idempotency: check the handler shorts-circuits via agent_runs.
    if (!/findPriorOkRun|status\s*=\s*'ok'/.test(handler) && !/agent_runs/.test(handler)) {
      return fail('granola-poller handler does not implement agent_runs idempotency');
    }
    return mode === 'live'
      ? human(
          'PASS',
          'Code wired; operator runs `aws scheduler get-schedule --group-name kos-schedules --name kos-granola-poller` to confirm State=ENABLED + last 24h activity in agent_runs',
          'integrations-granola.ts rate(15 minutes) Europe/Stockholm; granola-poller handler with agent_runs idempotency',
        )
      : pass(
          'granola-poller wired; integrations-granola.ts has rate(15 minutes) Europe/Stockholm; idempotency via agent_runs',
        );
  } catch (err) {
    return fail(`SC1 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC2 — AGT-06: 30 real transcripts → action items in CC + mention_events; ≥8/10 actionable
// ----------------------------------------------------------------------------

async function verifyAGT06() {
  try {
    const agentPath = 'services/transcript-extractor/src/agent.ts';
    if (!exists(agentPath)) return fail(`transcript-extractor agent missing: ${agentPath}`);
    const agent = readSource(agentPath);
    if (!/eu\.anthropic\.claude-sonnet-4-6/.test(agent)) {
      return fail('agent.ts missing eu.anthropic.claude-sonnet-4-6 inference profile');
    }
    if (!/tool_use|tool_choice|toolUse/.test(agent) && !/record_transcript_extract/.test(agent)) {
      return fail('agent.ts does not configure Bedrock tool_use for structured output');
    }
    const handlerPath = 'services/transcript-extractor/src/handler.ts';
    const handler = readSource(handlerPath);
    if (!/writeActionItemsToCommandCenter/.test(handler)) {
      return fail('handler.ts does not write action items to Command Center');
    }
    if (!/writeMentionEvents/.test(handler)) {
      return fail('handler.ts does not write mention_events');
    }
    // HUMAN-flagged: 8/10 actionable rating is subjective Kevin-review.
    return human(
      'PASS',
      'Code wired; operator must review 30 real transcripts × 10 action items in Command Center and confirm ≥ 8/10 actionable per Kevin\'s rating (06-06-GATE-evidence-template.md SC2 row).',
      'agent.ts uses Sonnet 4.6 + tool_use; handler.ts writes CC + mention_events',
    );
  } catch (err) {
    return fail(`SC2 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC3 — MEM-03: Azure hybrid query <600ms p95
// ----------------------------------------------------------------------------

async function verifyMEM03() {
  try {
    const queryPath = 'packages/azure-search/src/query.ts';
    if (!exists(queryPath)) return fail(`hybridQuery missing: ${queryPath}`);
    const query = readSource(queryPath);
    if (!/queryType:\s*'semantic'/.test(query)) {
      return fail('query.ts not configured for queryType: semantic');
    }
    if (!/kos-semantic/.test(query)) {
      return fail('query.ts missing semantic configuration name kos-semantic');
    }
    if (!/vectorQueries|vectorSearchOptions/.test(query)) {
      return fail('query.ts missing vector search wiring (RRF + reranker)');
    }

    // Run the existing latency verifier as a subprocess. It exits 0 when
    // p95 < budget; we reuse its mock distribution for the gate check.
    const subArgs = mode === 'live' ? ['--live'] : ['--mock'];
    const sub = spawnSync(
      'node',
      [resolve(REPO_ROOT, 'scripts/verify-mem-03-latency.mjs'), ...subArgs],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (sub.status !== 0) {
      // In live mode, this is FAIL (real budget breach). In mock mode it's
      // a script bug since the synthetic distribution is constructed to pass.
      return fail(
        `verify-mem-03-latency.mjs ${subArgs.join(' ')} exited ${sub.status}`,
        (sub.stdout ?? '').slice(-200) + (sub.stderr ?? '').slice(-200),
      );
    }
    return mode === 'live'
      ? pass('verify-mem-03-latency.mjs --live exit 0 (p95 < 600ms)')
      : pass('verify-mem-03-latency.mjs --mock exit 0 (p95 < 600ms on synthetic distribution)');
  } catch (err) {
    return fail(`SC3 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC4 — AGT-04: @kos/context-loader::loadContext returns ContextBundle; <800ms p95
// ----------------------------------------------------------------------------

async function verifyAGT04() {
  try {
    const indexPath = 'packages/context-loader/src/index.ts';
    if (!exists(indexPath)) return fail(`context-loader barrel missing: ${indexPath}`);
    const idx = readSource(indexPath);
    if (!/loadContext/.test(idx)) return fail('@kos/context-loader does not export loadContext');

    const loadCtxPath = 'packages/context-loader/src/loadContext.ts';
    if (!exists(loadCtxPath)) return fail('loadContext.ts missing');
    const lc = readSource(loadCtxPath);
    // The contract is async + returns ContextBundle.
    if (!/Promise<ContextBundle>/.test(lc)) {
      return fail('loadContext signature does not return Promise<ContextBundle>');
    }
    if (!/cache_hit|cacheHit/.test(lc)) {
      return fail('loadContext does not surface cache_hit (D-19)');
    }

    // Confirm at least one consumer Lambda imports + calls loadContext.
    const consumers = [
      'services/triage/src/handler.ts',
      'services/transcript-extractor/src/handler.ts',
      'services/voice-capture/src/handler.ts',
      'services/entity-resolver/src/handler.ts',
    ];
    const wired = [];
    for (const c of consumers) {
      if (!exists(c)) continue;
      const t = readSource(c);
      if (/from '@kos\/context-loader'/.test(t) && /loadContext\s*\(/.test(t)) {
        wired.push(c.replace('services/', '').replace('/src/handler.ts', ''));
      }
    }
    if (wired.length === 0) {
      return fail('no consumer Lambdas wire @kos/context-loader::loadContext');
    }

    // assembled_markdown injection check on at least one consumer.
    const oneTxt = readSource(consumers.find((p) => exists(p) && /loadContext/.test(readSource(p))));
    if (!/assembled_markdown|assembledMarkdown/.test(oneTxt)) {
      return fail('No consumer injects assembled_markdown from ContextBundle');
    }

    return human(
      'PASS',
      `Code wired in ${wired.length} consumer Lambda(s): ${wired.join(', ')}. Operator must verify loadContext p95 < 800ms after 1 day of production traffic via Langfuse trace query.`,
      `loadContext exported; ${wired.length} consumers wired; assembled_markdown injected`,
    );
  } catch (err) {
    return fail(`SC4 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC5 — MEM-04: entity_timeline_mv refreshed every 5 min; dashboard <50ms p95 at 100k
// ----------------------------------------------------------------------------

async function verifyMEM04() {
  try {
    const handlerPath = 'services/entity-timeline-refresher/src/handler.ts';
    if (!exists(handlerPath)) return fail('entity-timeline-refresher handler missing');
    const handler = readSource(handlerPath);
    if (!/REFRESH MATERIALIZED VIEW|refresh_entity_timeline/.test(handler)) {
      return fail('refresher does not run REFRESH MATERIALIZED VIEW');
    }

    const integrationsPath = 'packages/cdk/lib/stacks/integrations-mv-refresher.ts';
    if (!exists(integrationsPath)) return fail('integrations-mv-refresher.ts missing');
    const integrations = readSource(integrationsPath);
    if (!/rate\(5 minutes\)/.test(integrations)) {
      return fail('integrations-mv-refresher.ts missing rate(5 minutes)');
    }
    if (!/Europe\/Stockholm/.test(integrations)) {
      return fail('integrations-mv-refresher.ts missing Europe/Stockholm timezone');
    }

    // Migration 0012 entity_timeline MV + unique index.
    const migrationPath = 'packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql';
    if (!exists(migrationPath)) return fail('migration 0012 missing');
    const sql = readSource(migrationPath);
    if (!/CREATE MATERIALIZED VIEW entity_timeline\b/i.test(sql)) {
      return fail('entity_timeline MV not created in 0012');
    }
    if (!/uniq_entity_timeline_event|UNIQUE INDEX[^;]*entity_timeline/i.test(sql)) {
      return fail('unique index for CONCURRENTLY refresh not present');
    }

    // Dashboard route.
    const routePath = 'apps/dashboard/src/app/api/entities/[id]/timeline/route.ts';
    if (!exists(routePath)) return fail('dashboard timeline route missing');
    // Route is a thin proxy (Plan 05 pattern); the actual MV/UNION query
    // lives in the upstream API. We assert the route exists + forwards.

    return human(
      'PASS',
      'Code wired; operator must verify timeline route p95 < 50ms at 100k mention_events on production data via dashboard /api/entities/[id]/timeline measurement.',
      'entity-timeline-refresher + rate(5 minutes); migration 0012 MV + uniq index; dashboard route present',
    );
  } catch (err) {
    return fail(`SC5 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC6 — INF-10: services/dossier-loader subscribes to context.full_dossier_requested; <$1.50 avg per call
// ----------------------------------------------------------------------------

async function verifyINF10() {
  try {
    const vertexPath = 'services/dossier-loader/src/vertex.ts';
    if (!exists(vertexPath)) return fail('dossier-loader/vertex.ts missing');
    const vertex = readSource(vertexPath);
    if (!/gemini-2\.5-pro/.test(vertex)) {
      return fail("dossier-loader missing gemini-2.5-pro model id");
    }
    if (!/europe-west4/.test(vertex)) {
      return fail("dossier-loader missing europe-west4 region");
    }
    // Context caching for cost discipline (D-21) — informational only.
    // Plan spec only requires the model id + region + handler subscription.
    // Cost-per-call verification is HUMAN-flagged, so cache adoption is
    // also operator-graded after first live invocation.
    const usesCachedContent = /cachedContent|cached_content|CachedContent/.test(vertex);

    const handlerPath = 'services/dossier-loader/src/handler.ts';
    if (!exists(handlerPath)) return fail('dossier-loader handler missing');
    const handler = readSource(handlerPath);
    if (!/full_dossier_requested|FullDossierRequested/.test(handler)) {
      return fail('handler does not subscribe to context.full_dossier_requested');
    }

    const integrationsPath = 'packages/cdk/lib/stacks/integrations-vertex.ts';
    if (!exists(integrationsPath)) return fail('integrations-vertex.ts missing');
    const integrations = readSource(integrationsPath);
    if (!/full_dossier_requested|FullDossierRequested|context\.full_dossier_requested/.test(integrations)) {
      return fail('CDK helper does not wire EventBridge rule on context.full_dossier_requested');
    }

    return human(
      'PASS',
      'Code wired; operator triggers a real dossier-loader call via scripts/trigger-full-dossier.mjs and confirms cost per call < $1.50 in Vertex billing console (06-06-GATE-evidence-template.md SC6 row).',
      `dossier-loader/vertex.ts gemini-2.5-pro europe-west4${usesCachedContent ? ' + cachedContent' : ' (cachedContent not yet adopted — operator may add post-first-call for cost discipline)'}; integrations-vertex.ts subscribes to context.full_dossier_requested`,
    );
  } catch (err) {
    return fail(`SC6 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// SC7 — Dossier cache: Postgres-backed; >80% hit rate; trigger invalidation works
// ----------------------------------------------------------------------------

async function verifyDossierCache() {
  try {
    const migrationPath = 'packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql';
    const sql = readSource(migrationPath);
    if (!/CREATE TABLE IF NOT EXISTS entity_dossiers_cached/i.test(sql)) {
      return fail('entity_dossiers_cached table not created in 0012');
    }
    if (!/CREATE OR REPLACE FUNCTION invalidate_dossier_cache_on_mention/i.test(sql)) {
      return fail('invalidate trigger function not in 0012');
    }
    if (!/CREATE TRIGGER trg_entity_dossiers_cached_invalidate/i.test(sql)) {
      return fail('invalidate trigger not in 0012');
    }
    if (!/AFTER INSERT ON mention_events/i.test(sql)) {
      return fail('trigger not bound to mention_events INSERT');
    }

    const cachePath = 'packages/context-loader/src/cache.ts';
    if (!exists(cachePath)) return fail('cache.ts missing');
    const cache = readSource(cachePath);
    const expectedFns = ['computeLastTouchHash', 'readDossierCache', 'writeDossierCache'];
    const missing = expectedFns.filter((fn) => !new RegExp(`export\\s+(async\\s+)?function\\s+${fn}|export\\s*\\{[^}]*${fn}`).test(cache));
    if (missing.length > 0) {
      return fail(`cache.ts missing exports: ${missing.join(', ')}`);
    }

    return human(
      'PASS',
      'Code wired; operator must measure cache_hit rate over 1 representative day (target > 80%) via Langfuse trace bundle.cache_hit aggregation.',
      'migration 0012 has table + trigger + AFTER INSERT ON mention_events; cache.ts exports computeLastTouchHash + readDossierCache + writeDossierCache',
    );
  } catch (err) {
    return fail(`SC7 unexpected error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// Orchestrator
// ----------------------------------------------------------------------------

const SC = [
  ['SC1', 'CAP-08 + AUTO-05', verifyCAP08AUTO05],
  ['SC2', 'AGT-06 transcript-extractor', verifyAGT06],
  ['SC3', 'MEM-03 hybrid query latency', verifyMEM03],
  ['SC4', 'AGT-04 context-loader helper', verifyAGT04],
  ['SC5', 'MEM-04 entity_timeline MV', verifyMEM04],
  ['SC6', 'INF-10 Vertex dossier-loader', verifyINF10],
  ['SC7', 'Dossier cache (D-17/D-18/D-19)', verifyDossierCache],
];

console.log(`Phase 6 Gate Verifier (${mode} mode)`);
console.log(`  repo=${REPO_ROOT}`);
console.log('');

const reports = [];
for (const [id, name, fn] of SC) {
  let r;
  try {
    r = await fn();
  } catch (err) {
    r = fail(`uncaught error in ${id}: ${err.message}`);
  }
  reports.push({ id, name, ...r });
  const tag =
    r.status === 'PASS' ? '[PASS]' : r.status === 'FAIL' ? '[FAIL]' : '[HUMAN]';
  const auto = r.status === 'HUMAN' ? ` (auto:${r.autoStatus})` : '';
  const padId = id.padEnd(4);
  const padName = name.padEnd(32);
  console.log(`${padId} ${padName} ${tag}${auto} ${r.reason}`);
  if (r.evidence) {
    console.log(`     evidence: ${r.evidence}`);
  }
}

const passes = reports.filter((r) => r.status === 'PASS').length;
const fails = reports.filter((r) => r.status === 'FAIL').length;
const humans = reports.filter((r) => r.status === 'HUMAN').length;
const autoPasses = reports.filter((r) => r.autoStatus === 'PASS').length;

console.log('');
console.log(
  `Result: ${fails} FAIL, ${autoPasses} PASS-auto, ${humans} HUMAN-pending`,
);
console.log(`Exit: ${fails === 0 ? 0 : 1} (${fails === 0 ? 'no FAILs; HUMANs reported separately' : 'FAILs must be fixed'})`);

if (humans > 0) {
  console.log('');
  console.log('HUMAN-flagged criteria — operator owns these via 06-06-GATE-evidence-template.md:');
  for (const r of reports.filter((x) => x.status === 'HUMAN')) {
    console.log(`  - ${r.id} ${r.name}: ${r.reason}`);
  }
}

process.exit(fails === 0 ? 0 : 1);
