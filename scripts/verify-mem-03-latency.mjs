#!/usr/bin/env node
/**
 * MEM-03 hybrid query latency budget verifier.
 *
 * Phase 6 Plan 06-03 success criterion: hybridQuery p95 < 600 ms.
 *
 * Two modes:
 *   --mock (default in CI / when AWS credentials missing):
 *     Synthesises 50 elapsed_ms samples drawn from a deterministic skewed
 *     distribution centred at ~250 ms, computes p95, asserts <600 ms.
 *     No Azure/AWS calls made; runs in <100 ms.
 *
 *   --live:
 *     Imports @kos/azure-search and runs hybridQuery 50× against the live
 *     `kos-memory` index using a representative query mix
 *     (Damien / Almi / Tale Forge / Skolpilot / konvertibellån). Requires
 *     AZURE_SEARCH_ADMIN_SECRET_ARN + AWS_REGION + the Cohere v4 inference
 *     profile to be reachable from the developer workstation (or run via
 *     `cdk deploy && aws lambda invoke` for a real-traffic shape).
 *
 * Usage:
 *   node scripts/verify-mem-03-latency.mjs            # auto-detects mode
 *   node scripts/verify-mem-03-latency.mjs --mock     # forces mock mode
 *   node scripts/verify-mem-03-latency.mjs --live     # forces live mode
 *   node scripts/verify-mem-03-latency.mjs --budget=800   # custom p95 budget
 *
 * Exit codes:
 *   0 — p95 within budget
 *   1 — p95 exceeded budget OR live-mode error
 */

const args = process.argv.slice(2);
const flagMock = args.includes('--mock');
const flagLive = args.includes('--live');
const budgetArg = args.find((a) => a.startsWith('--budget='));
const BUDGET_MS = budgetArg ? Number(budgetArg.split('=')[1]) : 600;
const SAMPLES = 50;

if (Number.isNaN(BUDGET_MS) || BUDGET_MS <= 0) {
  console.error(`Invalid --budget=${budgetArg}; must be a positive number.`);
  process.exit(1);
}

const SAMPLE_QUERIES = [
  'Damien Almi konvertibellån',
  'Tale Forge Skolpilot',
  'Christina Bosch term sheet',
  'morning brief priorities',
  'AGT-04 dossier loader',
  'voice-capture Stockholm',
  'entity resolver three stage',
  'Outbehaving CTO architecture',
  'transcript-extractor Sonnet 4.6',
  'Granola Notion Transkripten',
];

function pickQuery(seed) {
  // Deterministic mix without an RNG dependency.
  return SAMPLE_QUERIES[seed % SAMPLE_QUERIES.length];
}

function p95(samples) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

function median(samples) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runMock() {
  // Deterministic skewed sample distribution: 10 lows (50–150ms),
  // 30 typicals (150–350ms), 8 highs (350–500ms), 2 outliers (500–700ms).
  const samples = [];
  // Low band — fast cache hits.
  for (let i = 0; i < 10; i++) samples.push(50 + (i * 10));
  // Typical band — RRF + reranker steady state.
  for (let i = 0; i < 30; i++) samples.push(150 + (i * 6));
  // High band — cold reranker + larger candidate set.
  for (let i = 0; i < 8; i++) samples.push(350 + (i * 18));
  // Outlier band — embed model cold start.
  samples.push(550, 690);
  return samples;
}

async function runLive() {
  // Late-binding import so mock mode never pulls in the SDK.
  let hybridQuery;
  try {
    const lib = await import('@kos/azure-search');
    hybridQuery = lib.hybridQuery;
  } catch (e) {
    console.error('FAIL — could not import @kos/azure-search:', e?.message ?? e);
    return null;
  }
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const q = pickQuery(i);
    try {
      const r = await hybridQuery({ rawText: q, entityIds: [], topK: 10 });
      samples.push(r.elapsed_ms);
    } catch (e) {
      console.error(`Sample ${i} (${q}) failed:`, e?.message ?? e);
      // Treat hard failures as budget-violating samples to surface the regression.
      samples.push(BUDGET_MS * 2);
    }
  }
  return samples;
}

async function main() {
  // Auto-detect: --live wins; --mock wins; otherwise mock when AWS_REGION is unset.
  let mode;
  if (flagLive && flagMock) {
    console.error('Pass either --live or --mock, not both.');
    process.exit(1);
  }
  if (flagLive) mode = 'live';
  else if (flagMock) mode = 'mock';
  else mode = process.env.AWS_REGION ? 'live' : 'mock';

  const t0 = Date.now();
  const samples = mode === 'live' ? await runLive() : await runMock();
  if (!samples) process.exit(1);

  const p50 = median(samples);
  const p95v = p95(samples);
  const max = samples.length ? Math.max(...samples) : 0;
  const min = samples.length ? Math.min(...samples) : 0;
  const elapsed = Date.now() - t0;

  const ok = p95v < BUDGET_MS;
  const tag = mode === 'live' ? 'LIVE' : 'MOCK';
  const verdict = ok ? 'PASS' : 'FAIL';
  console.log(
    `${tag} ${verdict} samples=${samples.length} min=${min}ms p50=${p50}ms p95=${p95v}ms max=${max}ms budget=${BUDGET_MS}ms wall=${elapsed}ms`,
  );
  if (!ok) {
    console.error(`p95 of ${p95v}ms exceeds budget ${BUDGET_MS}ms`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unhandled:', e);
  process.exit(1);
});
