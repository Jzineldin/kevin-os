#!/usr/bin/env node
/**
 * Gate 1 verifier — Phase 1 → Phase 2 crossover.
 *
 * One-command go/no-go for Phase 1. Runs every Gate 1 assertion as a
 * sequential step; exits 0 only when ALL nine criteria are green.
 *
 * Mapping to ROADMAP.md Phase 1 Gate checklist:
 *   1. CDK deploy clean for 5 stacks (NetworkStack, DataStack, EventsStack,
 *      IntegrationsStack, SafetyStack)                       → step 1
 *   2. 5 EventBridge buses provisioned                        → step 2
 *   3. Postgres schema with owner_id on every table (+ pgvector) → step 3
 *   4. Notion Entities DB has all 13 spec fields              → step 4
 *   5. S3 VPC Gateway Endpoint verified                       → step 5
 *   6. Cost alarms active (Budgets + SNS confirmed)           → step 6
 *   7. VPS scripts frozen (Legacy Inbox receives; Command Center quiet) → step 7
 *   8. Azure AI Search index created with binary quantization → step 8
 *   9. archive-not-delete: event_log table (step 3) + weekly
 *      notion-reconcile schedule (step 9)                      → step 9
 *
 * Bonus steps (fail-soft; skipped with [SKIP] when prerequisites absent):
 *   - cap enforcement (requires 08-20 Stockholm active hours)
 *   - backfill idempotency (requires NOTION_TOKEN + bootstrapped DBs)
 *
 * Secrets auto-fetch:
 *   - DATABASE_URL: pulled from Secrets Manager secret matching
 *     `KosData*Credentials*` when not in env (mirrors scripts/db-push.sh).
 *   - NOTION_TOKEN: pulled from secret `kos/notion-token` when not in env.
 *
 * Exit codes:
 *   0 — all 9 green; Phase 1 → Phase 2 cleared.
 *   1 — at least one hard check failed.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { EventBridgeClient, ListEventBusesCommand } from '@aws-sdk/client-eventbridge';
// Budgets + SNS are invoked via the AWS CLI below — neither SDK is hoisted at
// the workspace root, and the CLI is a Gate 1 prerequisite anyway.

const REGION = process.env.AWS_REGION || 'eu-north-1';
const TRANSCRIBE_REGION = existsSync('scripts/.transcribe-region')
  ? readFileSync('scripts/.transcribe-region', 'utf8').trim()
  : REGION;
void TRANSCRIBE_REGION; // consumed by scripts/verify-transcribe-vocab.sh

const steps = [];
function record(name, fn) {
  steps.push({ name, fn });
}

// --- 1/9. CDK stacks deployed -----------------------------------------------
record('1/9 CDK stacks deployed (KosNetwork, KosData, KosEvents, KosIntegrations, KosSafety)', async () => {
  execSync('bash scripts/verify-stacks-exist.sh', { stdio: 'inherit' });
});

// --- 2/9. Five EventBridge buses --------------------------------------------
record('2/9 EventBridge buses (kos.capture / kos.triage / kos.agent / kos.output / kos.system)', async () => {
  const eb = new EventBridgeClient({ region: REGION });
  const out = await eb.send(new ListEventBusesCommand({}));
  const names = (out.EventBuses ?? [])
    .map((b) => b.Name)
    .filter((n) => typeof n === 'string' && n.startsWith('kos.'));
  const expected = ['kos.agent', 'kos.capture', 'kos.output', 'kos.system', 'kos.triage'];
  const missing = expected.filter((e) => !names.includes(e));
  if (missing.length > 0) throw new Error(`Missing buses: ${missing.join(', ')}`);
});

// --- 3/9. Postgres: pgvector + all 8 tables + owner_id on each --------------
record('3/9 Postgres: pgvector + 8 tables + owner_id on each + event_log present', async () => {
  // Unit sweep (fail-fast before any network hop).
  execSync('pnpm --filter @kos/db test -- --run owner-sweep', { stdio: 'inherit' });

  // Live DB assertions — DATABASE_URL auto-fetched from Secrets Manager.
  // Gate 1 MUST NOT silent-skip these.
  if (!process.env.DATABASE_URL) {
    const arn = execSync(
      `aws secretsmanager list-secrets --region ${REGION} --query "SecretList[?starts_with(Name, 'KosData') && contains(Name, 'Credentials')].ARN | [0]" --output text`,
    )
      .toString()
      .trim();
    if (!arn || arn === 'None') {
      throw new Error('KosData RDS credentials secret not found in Secrets Manager');
    }
    const json = execSync(
      `aws secretsmanager get-secret-value --secret-id ${arn} --region ${REGION} --query SecretString --output text`,
    )
      .toString()
      .trim();
    const creds = JSON.parse(json);
    const tunnelPort = process.env.KOS_DB_TUNNEL_PORT;
    const host = tunnelPort ? '127.0.0.1' : creds.host;
    const port = tunnelPort || creds.port;
    process.env.DATABASE_URL = `postgresql://${creds.username}:${creds.password}@${host}:${port}/kos?sslmode=require`;
  }

  const pgvec = execSync(
    `psql "$DATABASE_URL" -tA -c "SELECT extversion FROM pg_extension WHERE extname='vector';"`,
  )
    .toString()
    .trim();
  if (!pgvec) throw new Error('pgvector extension missing on live RDS');

  const count = execSync(
    `psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('entity_index','project_index','agent_runs','notion_indexer_cursor','mention_events','event_log','telegram_inbox_queue','kevin_context');"`,
  )
    .toString()
    .trim();
  if (count !== '8') throw new Error(`Expected 8 tables, got ${count}`);

  const missingOwner = execSync(
    `psql "$DATABASE_URL" -tA -c "SELECT table_name FROM information_schema.tables t WHERE t.table_schema='public' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name='owner_id') AND t.table_name NOT LIKE 'pg_%' AND t.table_type='BASE TABLE';"`,
  )
    .toString()
    .trim();
  if (missingOwner) throw new Error(`Tables missing owner_id: ${missingOwner}`);

  // archive-not-delete sink: event_log must exist — reconciler writes
  // notion-hard-delete rows here (step 9 cross-check).
  const eventLogExists = execSync(
    `psql "$DATABASE_URL" -tA -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='event_log';"`,
  )
    .toString()
    .trim();
  if (eventLogExists !== '1') {
    throw new Error('event_log table missing — archive-not-delete sink absent');
  }
});

// --- 4/9. Notion Entities (13 fields) + Projects + all 5 DB IDs -------------
record('4/9 Notion Entities DB (13 fields) + Projects DB + all 5 DB IDs in .notion-db-ids.json', async () => {
  const ids = JSON.parse(readFileSync('scripts/.notion-db-ids.json', 'utf8'));
  // D-11: 4 watched DBs + Legacy Inbox + Command Center — all IDs must be populated.
  for (const k of ['entities', 'projects', 'kevinContext', 'legacyInbox', 'commandCenter']) {
    if (!ids[k]) throw new Error(`.notion-db-ids.json missing key ${k}`);
    if (ids[k] === 'pending-bootstrap') {
      throw new Error(`.notion-db-ids.json key ${k} still 'pending-bootstrap' — run notion:bootstrap`);
    }
  }

  let token = process.env.NOTION_TOKEN;
  if (!token) {
    const sm = new SecretsManagerClient({ region: REGION });
    const r = await sm.send(new GetSecretValueCommand({ SecretId: 'kos/notion-token' }));
    token = r.SecretString;
    if (!token) {
      throw new Error('NOTION_TOKEN not in env and secret kos/notion-token empty');
    }
  }

  const eReq = await fetch(`https://api.notion.com/v1/databases/${ids.entities}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  });
  const e = await eReq.json();
  const props = Object.keys(e.properties ?? {});
  const expected = [
    'Name',
    'Aliases',
    'Type',
    'Org',
    'Role',
    'Relationship',
    'Status',
    'LinkedProjects',
    'SeedContext',
    'LastTouch',
    'ManualNotes',
    'Confidence',
    'Source',
  ];
  const missing = expected.filter((p) => !props.includes(p));
  if (missing.length > 0) {
    throw new Error(`Entities DB missing fields: ${missing.join(', ')}`);
  }

  const pReq = await fetch(`https://api.notion.com/v1/databases/${ids.projects}`, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  });
  const pj = await pReq.json();
  const pProps = Object.keys(pj.properties ?? {});
  for (const f of ['Name', 'Bolag', 'Status', 'Description', 'LinkedPeople', 'SeedContext']) {
    if (!pProps.includes(f)) throw new Error(`Projects DB missing field ${f}`);
  }
});

// --- 5/9. S3 Gateway Endpoint ----------------------------------------------
record('5/9 S3 Gateway VPC Endpoint present', async () => {
  const resOut = execSync(
    `aws ec2 describe-vpc-endpoints --region ${REGION} --filters Name=service-name,Values=com.amazonaws.${REGION}.s3 --query "VpcEndpoints[?VpcEndpointType=='Gateway'] | length(@)" --output text`,
  )
    .toString()
    .trim();
  if (parseInt(resOut, 10) < 1) throw new Error('S3 Gateway VPC Endpoint not found');
});

// --- 6/9. Budgets + SNS confirmed ------------------------------------------
record('6/9 AWS Budgets (kos-monthly) + SNS email subscription confirmed', async () => {
  // Budgets is a global service; us-east-1 is the canonical endpoint.
  const acct = execSync('aws sts get-caller-identity --query Account --output text').toString().trim();
  const budgetOut = execSync(
    `aws budgets describe-budgets --account-id ${acct} --region us-east-1 --query "Budgets[?BudgetName=='kos-monthly'].BudgetName | [0]" --output text`,
  )
    .toString()
    .trim();
  if (!budgetOut || budgetOut === 'None') throw new Error('Budget kos-monthly missing');

  const topicArn = execSync(
    `aws sns list-topics --region ${REGION} --query "Topics[?contains(TopicArn, 'CostAlarmTopic')].TopicArn | [0]" --output text`,
  )
    .toString()
    .trim();
  if (!topicArn || topicArn === 'None') throw new Error('CostAlarmTopic not found');
  const pendingCount = execSync(
    `aws sns list-subscriptions-by-topic --topic-arn ${topicArn} --region ${REGION} --query "length(Subscriptions[?SubscriptionArn=='PendingConfirmation'])" --output text`,
  )
    .toString()
    .trim();
  if (pendingCount !== '0') {
    throw new Error(
      'SNS email subscription still PendingConfirmation — click confirm link in kevin@tale-forge.app inbox',
    );
  }
});

// --- 7/9. VPS freeze (initial + 48h observation) ----------------------------
record('7/9 VPS freeze — Legacy Inbox receives, Command Center quiet (initial + 48h)', async () => {
  execSync('node scripts/verify-vps-freeze.mjs', { stdio: 'inherit' });
  execSync('node scripts/verify-vps-freeze-48h.mjs', { stdio: 'inherit' });
});

// --- 8/9. Azure AI Search binary quantization -------------------------------
record('8/9 Azure AI Search index has binary quantization', async () => {
  execSync('node scripts/verify-azure-index.mjs', { stdio: 'inherit' });
});

// --- 9/9. Transcribe vocab READY + notion-reconcile weekly schedule ---------
record('9/9 Transcribe sv-SE vocab READY + notion-reconcile-weekly schedule live', async () => {
  execSync('bash scripts/verify-transcribe-vocab.sh', { stdio: 'inherit' });
  // archive-not-delete architectural check: weekly reconciler is wired
  // (hard-delete detection on D-11 watched DBs).
  const reconcileCount = execSync(
    `aws scheduler list-schedules --group-name kos-schedules --region ${REGION} --query "length(Schedules[?Name==\`notion-reconcile-weekly\`])" --output text`,
  )
    .toString()
    .trim();
  if (reconcileCount !== '1') {
    throw new Error('notion-reconcile-weekly schedule missing — hard-delete detection not wired');
  }
});

// --- Bonus: cap enforcement (quiet hours gate) ------------------------------
record('bonus: cap enforcement (runs 08-20 Stockholm only)', async () => {
  const hour = parseInt(
    new Date().toLocaleString('sv-SE', {
      timeZone: 'Europe/Stockholm',
      hour: '2-digit',
      hour12: false,
    }),
    10,
  );
  if (hour < 8 || hour >= 20) {
    console.log('[SKIP] cap test requires active hours 08-20 Stockholm');
    return;
  }
  execSync('node scripts/verify-cap.mjs', { stdio: 'inherit' });
});

// --- Bonus: backfill idempotency --------------------------------------------
record('bonus: backfill idempotency (second run yields 0 new rows)', async () => {
  execSync('bash scripts/backfill-notion.sh', { stdio: 'inherit' });
});

// --- Run all ----------------------------------------------------------------
let failed = 0;
const startEpoch = Date.now();
for (const s of steps) {
  const stepStart = Date.now();
  process.stdout.write(`\n=== ${s.name} ===\n`);
  try {
    await s.fn();
    const dt = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(`[OK] ${s.name} (${dt}s)`);
  } catch (e) {
    const dt = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.error(`[FAIL] ${s.name} (${dt}s): ${e?.message ?? e}`);
    failed++;
  }
}
const totalDt = ((Date.now() - startEpoch) / 1000).toFixed(1);
if (failed > 0) {
  console.error(`\nGate 1: ${failed} failing check(s). Phase 1 NOT ready. [${totalDt}s]`);
  process.exit(1);
}
console.log(`\n[OK] Gate 1: ALL CHECKS GREEN — Phase 1 → Phase 2 cleared. [${totalDt}s]`);
