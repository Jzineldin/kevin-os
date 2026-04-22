#!/usr/bin/env node
/**
 * verify-resolver-three-stage.mjs — Phase 2a Gate 2 resolver scoreboard.
 *
 * Reads scripts/fixtures/resolver-three-stage-mentions.json (20 curated
 * mentions covering all three resolver stages: auto-merge / llm-disambig /
 * inbox) and:
 *
 *   1. For each mention, generates a fresh ULID capture_id and publishes one
 *      `entity.mention.detected` event to the kos.agent EventBridge bus.
 *   2. After all events are published, polls the entity-resolver Lambda's
 *      CloudWatch Logs Insights for each capture_id, extracting the routed
 *      stage (auto-merge / llm-disambig / inbox) and the matched entity id
 *      (if any).
 *   3. Writes a scoreboard markdown file at
 *      .planning/phases/02-minimum-viable-loop/02-11-e2e-results-<date>.md
 *      with one row per mention: expected vs actual + a Kevin's-gut review
 *      column (D-16 — operator must subjectively confirm).
 *   4. Prints per-stage pass/fail tallies to stdout for the operator.
 *
 * Note on "actual" extraction: the resolver Lambda's structured logs include
 * the stage in either an explicit `stage` field or as a substring of the
 * agent_runs `agent_name` (e.g., entity-resolver.merge / .disambig / .inbox).
 * If neither is present, the field is left as <unknown> and the operator
 * fills it in from the Langfuse trace at
 * https://cloud.langfuse.com/sessions/<capture_id> — by design, since D-16
 * makes Phase 2 a Kevin's-gut gate, not a fully automated one.
 *
 * Usage:
 *   AWS_REGION=eu-north-1 \
 *     [VERIFY_FIXTURE=scripts/fixtures/resolver-three-stage-mentions.json] \
 *     [VERIFY_DEADLINE_MS=180000] \
 *     node scripts/verify-resolver-three-stage.mjs
 *
 * Always exits 0 — the scoreboard is operator-reviewed, not automated.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// --- ULID inline ---
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  const time = Date.now();
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    timePart = ULID_ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randPart = '';
  for (let i = 0; i < 16; i += 1) {
    randPart += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return timePart + randPart;
}

const region = process.env.AWS_REGION ?? 'eu-north-1';
const fixturePath =
  process.env.VERIFY_FIXTURE ??
  'scripts/fixtures/resolver-three-stage-mentions.json';
const POLL_DEADLINE_MS = Number(process.env.VERIFY_DEADLINE_MS ?? 180_000);

const eb = new EventBridgeClient({ region });
const cwl = new CloudWatchLogsClient({ region });

let mentions;
try {
  mentions = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch (err) {
  console.error(`[ERR] could not read fixture ${fixturePath}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(mentions) || mentions.length === 0) {
  console.error('[ERR] fixture must be a non-empty JSON array');
  process.exit(1);
}

console.log(`[verify-resolver-three-stage] region=${region}`);
console.log(`[verify-resolver-three-stage] mentions: ${mentions.length}`);
console.log(`[verify-resolver-three-stage] poll deadline: ${POLL_DEADLINE_MS / 1000}s\n`);

// --- Step 1: Publish entity.mention.detected for each mention ---
const startedAt = Date.now();
const published = [];
for (const m of mentions) {
  const captureId = ulid();
  const detail = {
    capture_id: captureId,
    mention_text: m.mention,
    context_snippet: m.context,
    candidate_type: m.type ?? 'Person',
    source: 'telegram-text',
    occurred_at: new Date().toISOString(),
  };
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: 'kos.agent',
          Source: 'kos.agent',
          DetailType: 'entity.mention.detected',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
  published.push({
    capture_id: captureId,
    mention: m.mention,
    context: m.context,
    type: m.type ?? 'Person',
    expected: m.expected_stage,
    notes: m.notes ?? '',
    actual: '<unknown>',
    matched_entity: null,
  });
  console.log(
    `[*] ${published.length.toString().padStart(2, ' ')}/${mentions.length} mention="${m.mention}" capture_id=${captureId} expected=${m.expected_stage}`,
  );
}
console.log(`\n[*] published all ${mentions.length} mentions in ${Date.now() - startedAt} ms\n`);

// --- Step 2: Find resolver log group + poll Logs Insights ---
async function findLogGroup(prefix) {
  const r = await cwl.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: `/aws/lambda/${prefix}`,
    }),
  );
  return r.logGroups?.[0]?.logGroupName ?? null;
}

const resolverLogGroup = await findLogGroup('KosAgents-EntityResolver');
console.log(`[verify-resolver-three-stage] resolver log group: ${resolverLogGroup ?? 'NOT-FOUND'}`);
if (!resolverLogGroup) {
  console.warn(`[warn] entity-resolver log group not found — scoreboard will list all stages as <unknown>; operator must fill from Langfuse.`);
}

async function pollResolverHits() {
  if (!resolverLogGroup) return new Map();
  // One Logs Insights query covering ALL capture_ids — uses regex OR.
  // Pattern keeps the query under the 10000 char limit even with 20 ULIDs.
  const captureIds = published.map((p) => p.capture_id);
  const filter = captureIds.map((id) => `'${id}'`).join(', ');
  const queryString = `
    fields @timestamp, @message
    | filter @message in [${filter}]
    | sort @timestamp asc
    | limit 1000
  `;
  const startQ = await cwl.send(
    new StartQueryCommand({
      logGroupName: resolverLogGroup,
      startTime: Math.floor((startedAt - 5_000) / 1000),
      endTime: Math.floor((Date.now() + 5_000) / 1000),
      queryString,
    }),
  );
  const queryId = startQ.queryId;
  const qDeadline = Date.now() + 60_000;
  let results = null;
  while (Date.now() < qDeadline) {
    const r = await cwl.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === 'Complete') {
      results = r.results ?? [];
      break;
    }
    if (r.status === 'Failed' || r.status === 'Cancelled') return new Map();
    await new Promise((res) => setTimeout(res, 1_500));
  }
  if (!results) return new Map();
  // Bucket messages by capture_id; extract stage hints.
  const byId = new Map();
  for (const row of results) {
    const msg = row.find((c) => c.field === '@message')?.value ?? '';
    for (const id of captureIds) {
      if (msg.includes(id)) {
        let stage = '<unknown>';
        let matched = null;
        if (/auto[_-]?merge|secondary[_-]?signal|project_cooccurrence/i.test(msg)) {
          stage = 'auto-merge';
        } else if (/llm[_-]?disambig|sonnet|disambig/i.test(msg)) {
          stage = 'llm-disambig';
        } else if (/inbox|pending|kos.?inbox/i.test(msg)) {
          stage = 'inbox';
        }
        const matchedRe = /matched_entity_id["':\s]+([0-9a-f-]{8,36})/i;
        const m = msg.match(matchedRe);
        if (m) matched = m[1];
        const prev = byId.get(id);
        if (!prev || (prev.stage === '<unknown>' && stage !== '<unknown>')) {
          byId.set(id, { stage, matched });
        }
      }
    }
  }
  return byId;
}

// Resolver may take 5-15s per mention (Sonnet for disambig); keep polling
// until either every capture_id has a stage OR we hit the deadline.
console.log(`[*] polling resolver logs (max ${POLL_DEADLINE_MS / 1000}s)…`);
const pollDeadline = startedAt + POLL_DEADLINE_MS;
let allKnown = false;
while (Date.now() < pollDeadline && !allKnown) {
  const byId = await pollResolverHits();
  for (const p of published) {
    const hit = byId.get(p.capture_id);
    if (hit && hit.stage !== '<unknown>') {
      p.actual = hit.stage;
      p.matched_entity = hit.matched;
    }
  }
  allKnown = published.every((p) => p.actual !== '<unknown>');
  if (allKnown) break;
  const known = published.filter((p) => p.actual !== '<unknown>').length;
  console.log(`    progress: ${known}/${published.length} resolved`);
  await new Promise((res) => setTimeout(res, 5_000));
}

// --- Step 3: tally + write scoreboard markdown ---
const tally = { 'auto-merge': { ok: 0, total: 0 }, 'llm-disambig': { ok: 0, total: 0 }, inbox: { ok: 0, total: 0 } };
for (const p of published) {
  const bucket = tally[p.expected];
  if (!bucket) continue;
  bucket.total += 1;
  if (p.expected === p.actual) bucket.ok += 1;
}

const ts = new Date().toISOString().slice(0, 10);
const outPath = `.planning/phases/02-minimum-viable-loop/02-11-e2e-results-${ts}.md`;
mkdirSync(dirname(outPath), { recursive: true });

const lines = [
  `# Phase 2 Resolver three-stage Scoreboard — ${ts}`,
  '',
  `**Mentions tested:** ${published.length}`,
  `**Polling deadline:** ${POLL_DEADLINE_MS / 1000}s`,
  `**Region:** ${region}`,
  `**Resolver log group:** \`${resolverLogGroup ?? '<not-found>'}\``,
  '',
  '## Per-stage tallies (auto-extracted from CloudWatch Logs)',
  '',
  '| Stage | Auto-passed | Total | Operator-review needed |',
  '|-------|-------------|-------|------------------------|',
  `| auto-merge | ${tally['auto-merge'].ok} | ${tally['auto-merge'].total} | check Langfuse for any \`<unknown>\` rows below |`,
  `| llm-disambig | ${tally['llm-disambig'].ok} | ${tally['llm-disambig'].total} | non-deterministic — Kevin\'s-gut judgment per D-16 |`,
  `| inbox | ${tally.inbox.ok} | ${tally.inbox.total} | confirm a Pending row appeared in KOS Inbox for each |`,
  '',
  '## Detailed scoreboard',
  '',
  '| # | Mention | Context | Type | Expected | Actual | Matched entity | Capture ID | Notes |',
  '|---|---------|---------|------|----------|--------|----------------|------------|-------|',
];
published.forEach((p, i) => {
  lines.push(
    `| ${i + 1} | \`${p.mention}\` | ${p.context.replace(/\|/g, '\\|')} | ${p.type} | ${p.expected} | ${p.actual} | ${p.matched_entity ?? '—'} | \`${p.capture_id}\` | ${p.notes.replace(/\|/g, '\\|')} |`,
  );
});
lines.push(
  '',
  '## Kevin\'s-gut review (D-16)',
  '',
  'Per D-16 the resolver gate is operator judgement, not an automated metric. For each row above:',
  '',
  '1. Cross-reference the `Actual` stage against the Langfuse trace at https://cloud.langfuse.com/sessions/<capture-id>.',
  '2. For `<unknown>` rows: open Langfuse, find the matching entity-resolver span, read off the routing decision, and update the row.',
  '3. For `inbox` rows: open the KOS Inbox Notion DB and confirm a Pending row appeared with `Source Capture ID` matching the ULID.',
  '4. For `auto-merge` rows: query Postgres `SELECT * FROM agent_runs WHERE capture_id IN (...) AND agent_name = \'entity-resolver.merge\' AND output_json->>\'secondary_signal\' = \'project_cooccurrence\';`',
  '5. Mark this scoreboard \\u201creviewed\\u201d in the Gate 2 evidence file by copying the auto-merge / llm-disambig / inbox tallies + a one-line note on whether the resolver \\u201cfeels right\\u201d for daily use.',
  '',
  '_If many `<unknown>` rows persist after Logs ingestion (~30-60s after the run), check that the resolver Lambda is logging the stage as plaintext in either the agent_name or a structured \"stage\" field. Optional script tweak: extend the regex hints inside `pollResolverHits()` to match the live log shape._',
  '',
);
writeFileSync(outPath, lines.join('\n'));

console.log('\n[*] tallies:');
for (const [stage, t] of Object.entries(tally)) {
  console.log(`    ${stage.padEnd(13)} ${t.ok}/${t.total}`);
}
const unknowns = published.filter((p) => p.actual === '<unknown>').length;
if (unknowns > 0) {
  console.log(`    <unknown>     ${unknowns} (operator must fill from Langfuse — D-16)`);
}
console.log(`\n[OK] wrote ${outPath}`);
console.log(`[OK] resolver three-stage scoreboard published — operator review per D-16.`);
