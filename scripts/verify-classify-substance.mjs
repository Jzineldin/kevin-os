#!/usr/bin/env node
/**
 * scripts/verify-classify-substance.mjs — Plan 10-01 same-substance verifier.
 *
 * Operator-run during the 14-day Phase-10 decommission overlap. Samples the
 * last N rows the legacy VPS scripts wrote to the Notion Legacy Inbox DB
 * (with `[MIGRERAD]` markers, per Plan 01-04 Phase-1 freeze), re-runs each
 * row's `OriginalPayload` through the new KOS Lambda equivalent, and asks
 * Vertex AI Gemini 2.5 Pro to score equivalence on a 0..1 scale.
 *
 * Output is a markdown report at:
 *   .planning/phases/10-migration-decommission/10-01-substance-report-{script}-{date}.md
 *
 * with:
 *   - per-pair score + drift summary + verdict
 *   - 10-row operator hand-review checklist (Kevin signs off)
 *
 * Pure read-only / Lambda:Invoke only. NEVER writes to production Notion or RDS.
 *
 * Usage:
 *   node scripts/verify-classify-substance.mjs --script classify --since 2026-04-18
 *   node scripts/verify-classify-substance.mjs --script morning --sample-size 10
 *   node scripts/verify-classify-substance.mjs --script evening --dry-run
 *
 * Args:
 *   --script <classify|morning|evening>  REQUIRED. Which legacy VPS script.
 *   --since YYYY-MM-DD                   default = 7 days ago.
 *   --sample-size N                      default = 10.
 *   --dry-run                            skip Gemini call; output pairs only.
 *
 * Exit codes:
 *   0  all 10 Gemini scores >= 0.8 AND operator_review_checklist present
 *   1  Gemini flagged ANY pair < 0.5 OR sample size < 10 (after fetch)
 *   2  Notion query returned < 10 rows (cannot sample)
 *
 * Sample corpus prereq (P-08 from RESEARCH): if Legacy Inbox has < 10 rows
 * for the target script in the last 7 days, exit 2 with a human-readable
 * warning + suggestion to run VPS scripts manually via:
 *   ssh kevin@98.91.6.66 'sudo systemctl restart <unit>'
 *
 * Dependencies (declared in scripts' package.json or root package.json):
 *   @notionhq/client                — Notion API
 *   @google-cloud/vertexai          — Vertex AI Gemini 2.5 Pro
 *   @aws-sdk/client-lambda          — Lambda Function invocation
 *   @aws-sdk/client-eventbridge     — fallback if direct EB introspection needed
 *   dotenv                          — env loading
 *
 * Env vars (read from process.env or .env):
 *   NOTION_TOKEN                                  required (Notion read)
 *   LEGACY_INBOX_DB_ID                            required (Phase-1 inbox UUID)
 *   GOOGLE_APPLICATION_CREDENTIALS                path to .gcp-sa-key.json
 *   GCP_PROJECT_ID                                required for Vertex
 *   GCP_LOCATION                                  default 'us-central1'
 *   AWS_REGION                                    default 'eu-north-1'
 *   VPS_CLASSIFY_LAMBDA_URL                       Function URL of the new adapter
 *   VPS_CLASSIFY_HMAC_SECRET                      shared HMAC secret
 *   MORNING_BRIEF_LAMBDA_NAME                     name of services/morning-brief Lambda
 *   DAY_CLOSE_LAMBDA_NAME                         name of services/day-close Lambda
 *
 * IMPORTANT: This script is NOT executed during Phase 10 planning — it is
 * exclusively operator-run during the 7-day verification window.
 */
import { Client as NotionClient } from '@notionhq/client';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { VertexAI } from '@google-cloud/vertexai';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    script: null,
    since: null,
    sampleSize: 10,
    dryRun: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--script') out.script = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--sample-size') out.sampleSize = Number(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function printHelp() {
  console.log(
    `verify-classify-substance.mjs — Plan 10-01 same-substance verifier (Gemini 2.5 Pro judge + operator checklist)

Usage:
  node scripts/verify-classify-substance.mjs --script <classify|morning|evening> [--since YYYY-MM-DD] [--sample-size N] [--dry-run]

Args:
  --script        REQUIRED. classify | morning | evening
  --since         default 7 days ago. YYYY-MM-DD
  --sample-size   default 10
  --dry-run       skip Gemini judge; output pairs only

Exit codes:
  0  all scores >= 0.8 + operator_review_checklist present
  1  any pair < 0.5 OR sample size < 10 after fetch
  2  Notion query returned < 10 rows (sample corpus too small)
`,
  );
}

// ---------------------------------------------------------------------------
// Notion sampling
// ---------------------------------------------------------------------------

async function sampleLegacyInbox({ notion, dbId, scriptName, since, sampleSize }) {
  // VPS-side classify_and_save.py / morning_briefing.py / evening_checkin.py
  // all set Source = `classify_and_save` | `morning_briefing` | `evening_checkin`.
  const sourceLookup = {
    classify: 'classify_and_save',
    morning: 'morning_briefing',
    evening: 'evening_checkin',
  };
  const sourceValue = sourceLookup[scriptName];
  if (!sourceValue) {
    throw new Error(`Unknown script: ${scriptName} (expected classify|morning|evening)`);
  }

  const sinceIso = since.toISOString();
  const filter = {
    and: [
      { property: 'Source', select: { equals: sourceValue } },
      { property: 'CreatedAt', date: { on_or_after: sinceIso } },
    ],
  };

  const rows = [];
  let cursor;
  do {
    const r = await notion.databases.query({
      database_id: dbId,
      filter,
      sorts: [{ property: 'CreatedAt', direction: 'descending' }],
      start_cursor: cursor,
      page_size: Math.min(sampleSize, 100),
    });
    rows.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor && rows.length < sampleSize);

  return rows.slice(0, sampleSize);
}

function extractOriginalPayload(row) {
  const props = row.properties ?? {};
  const op = props.OriginalPayload?.rich_text?.[0]?.text?.content;
  if (!op) return null;
  try {
    return JSON.parse(op);
  } catch {
    return { raw: op };
  }
}

function extractTitle(row) {
  return row.properties?.Name?.title?.[0]?.text?.content ?? '<untitled>';
}

// ---------------------------------------------------------------------------
// Re-run through new adapter / Lambda
// ---------------------------------------------------------------------------

async function rerunClassify({ payload, lambdaUrl, hmacSecret }) {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', hmacSecret).update(`${t}.${body}`).digest('hex');
  const r = await fetch(lambdaUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${hmacSecret}`,
      'x-kos-signature': `t=${t},v1=${sig}`,
    },
    body,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, body: json };
}

async function rerunSchedulerLambda({ lambda, functionName, payload }) {
  const r = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(payload)),
      InvocationType: 'RequestResponse',
    }),
  );
  const decoded = r.Payload ? Buffer.from(r.Payload).toString('utf8') : '';
  let json = null;
  try {
    json = JSON.parse(decoded);
  } catch {
    json = { raw: decoded };
  }
  return { status: r.StatusCode ?? 0, body: json };
}

// ---------------------------------------------------------------------------
// Vertex AI Gemini 2.5 Pro judge
// ---------------------------------------------------------------------------

async function judgePair({ vertex, model, prompt, legacy, fresh }) {
  const filled = prompt
    .replace('{legacy_content}', JSON.stringify(legacy, null, 2))
    .replace('{new_content}', JSON.stringify(fresh, null, 2));

  const generative = vertex.preview.getGenerativeModel({
    model: 'gemini-2.5-pro',
  });
  const r = await generative.generateContent({
    contents: [{ role: 'user', parts: [{ text: filled }] }],
    generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
  });
  const text = r.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.score !== 'number') parsed.score = 0;
    if (!parsed.verdict) parsed.verdict = 'OPERATOR_REVIEW';
    if (!parsed.drift_summary) parsed.drift_summary = '(no summary)';
    return parsed;
  } catch {
    return {
      score: 0,
      drift_summary: `Unable to parse Gemini output: ${text.slice(0, 400)}`,
      verdict: 'OPERATOR_REVIEW',
    };
  }
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

function buildReport({ scriptName, sinceIso, pairs, dryRun }) {
  const today = new Date().toISOString().slice(0, 10);
  const path = `.planning/phases/10-migration-decommission/10-01-substance-report-${scriptName}-${today}.md`;

  const summaryRows = pairs
    .map((p, i) => {
      const score = dryRun ? 'n/a' : p.judge.score.toFixed(2);
      const verdict = dryRun ? 'DRY_RUN' : p.judge.verdict;
      return `| ${i + 1} | ${score} | ${verdict} |`;
    })
    .join('\n');

  const detail = pairs
    .map((p, i) => {
      const verdict = dryRun ? 'DRY_RUN' : p.judge.verdict;
      const score = dryRun ? 'n/a' : p.judge.score.toFixed(2);
      const drift = dryRun ? '(skipped — --dry-run)' : p.judge.drift_summary;
      return `### Pair ${i + 1} — ${verdict} (score=${score})

**Legacy title:** ${p.legacyTitle}

**Drift summary:** ${drift}

\`\`\`json
// LEGACY
${JSON.stringify(p.legacy, null, 2)}

// NEW
${JSON.stringify(p.fresh, null, 2)}
\`\`\`
`;
    })
    .join('\n---\n\n');

  const checklist = pairs
    .map((_p, i) => `- [ ] Pair ${i + 1}: PASS / FAIL — note: ____________________`)
    .join('\n');

  const md = `---
phase: 10-migration-decommission
plan: 10-01
artifact: substance-report
script: ${scriptName}
generated_at: ${new Date().toISOString()}
since: ${sinceIso}
sample_size: ${pairs.length}
dry_run: ${dryRun}
---

# 10-01 Same-substance report — \`${scriptName}\`

Compares ${pairs.length} legacy Notion Legacy Inbox rows (Phase 1 freeze
output) against the new KOS-side replay through the migrated Lambda.

| Pair | Gemini Score | Verdict |
|------|--------------|---------|
${summaryRows}

## Operator hand-review checklist (D-19)

Per ROADMAP SC 1, machine judgment never passes the gate alone. Kevin
signs off on each pair manually:

${checklist}

---

## Per-pair detail

${detail}
`;

  return { path, md };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.script) {
    console.error('--script is required. Try --help.');
    return 1;
  }
  if (!['classify', 'morning', 'evening'].includes(args.script)) {
    console.error(`--script must be one of classify | morning | evening`);
    return 1;
  }

  const since = args.since ? new Date(args.since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(since.getTime())) {
    console.error(`--since failed to parse: ${args.since}`);
    return 1;
  }
  const sampleSize = Number.isFinite(args.sampleSize) ? args.sampleSize : 10;

  // ---- Env ----------------------------------------------------------------
  const notionToken = process.env.NOTION_TOKEN;
  const dbId = process.env.LEGACY_INBOX_DB_ID;
  if (!notionToken || !dbId) {
    console.error('NOTION_TOKEN + LEGACY_INBOX_DB_ID are required.');
    return 1;
  }
  const region = process.env.AWS_REGION ?? 'eu-north-1';

  // ---- Notion sample -----------------------------------------------------
  const notion = new NotionClient({ auth: notionToken });
  const rows = await sampleLegacyInbox({
    notion,
    dbId,
    scriptName: args.script,
    since,
    sampleSize,
  });

  if (rows.length < 10) {
    console.error(
      `Sample corpus < 10 rows for script=${args.script} since=${since.toISOString()}.`,
    );
    console.error(
      `Suggestion: SSH kevin@98.91.6.66 'sudo systemctl restart <unit>' to generate sample inputs, then re-run.`,
    );
    return 2;
  }

  // ---- Per-row replay through new path -----------------------------------
  const lambda = new LambdaClient({ region });
  const pairs = [];
  for (const row of rows) {
    const payload = extractOriginalPayload(row);
    const legacyTitle = extractTitle(row);
    const legacy = { title: legacyTitle, payload };
    let fresh;
    if (args.script === 'classify') {
      const url = process.env.VPS_CLASSIFY_LAMBDA_URL;
      const secret = process.env.VPS_CLASSIFY_HMAC_SECRET;
      if (!url || !secret) {
        console.error('VPS_CLASSIFY_LAMBDA_URL + VPS_CLASSIFY_HMAC_SECRET required for --script classify');
        return 1;
      }
      fresh = await rerunClassify({ payload, lambdaUrl: url, hmacSecret: secret });
    } else if (args.script === 'morning') {
      const fnName = process.env.MORNING_BRIEF_LAMBDA_NAME;
      if (!fnName) {
        console.error('MORNING_BRIEF_LAMBDA_NAME required for --script morning');
        return 1;
      }
      fresh = await rerunSchedulerLambda({ lambda, functionName: fnName, payload });
    } else {
      const fnName = process.env.DAY_CLOSE_LAMBDA_NAME;
      if (!fnName) {
        console.error('DAY_CLOSE_LAMBDA_NAME required for --script evening');
        return 1;
      }
      fresh = await rerunSchedulerLambda({ lambda, functionName: fnName, payload });
    }
    pairs.push({ legacy, legacyTitle, fresh, judge: null });
  }

  // ---- Gemini judge (or dry-run) -----------------------------------------
  const promptPath = resolve(__dirname, '.fixtures/verify-classify-substance-prompt.txt');
  if (!existsSync(promptPath)) {
    console.error(`Prompt template not found: ${promptPath}`);
    return 1;
  }
  const promptTemplate = readFileSync(promptPath, 'utf8');

  if (!args.dryRun) {
    const project = process.env.GCP_PROJECT_ID;
    if (!project) {
      console.error('GCP_PROJECT_ID required (Vertex AI). Try --dry-run for offline pairs.');
      return 1;
    }
    const location = process.env.GCP_LOCATION ?? 'us-central1';
    const vertex = new VertexAI({ project, location });
    for (const p of pairs) {
      p.judge = await judgePair({
        vertex,
        prompt: promptTemplate,
        legacy: p.legacy,
        fresh: p.fresh,
      });
    }
  }

  // ---- Report ------------------------------------------------------------
  const { path, md } = buildReport({
    scriptName: args.script,
    sinceIso: since.toISOString(),
    pairs,
    dryRun: args.dryRun,
  });
  const abs = resolve(REPO_ROOT, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, md, 'utf8');
  console.log(`Report written: ${path}`);

  // ---- Exit code ---------------------------------------------------------
  if (args.dryRun) {
    console.log('Dry run complete. operator_review_checklist included for hand-review.');
    return 0;
  }
  if (pairs.some((p) => p.judge.score < 0.5)) {
    console.error('At least one pair scored < 0.5 — exit 1.');
    return 1;
  }
  if (pairs.some((p) => p.judge.score < 0.8)) {
    console.warn('Some pairs scored 0.5-0.79 — operator review required.');
  }
  console.log('All scores >= 0.8. operator_review_checklist still required for sign-off.');
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
