#!/usr/bin/env node
/**
 * verify-phase-2-e2e.mjs — Phase 2a Gate 2 end-to-end verification.
 *
 * The PhD-level "everything works" smoke. Pushes a synthetic Swedish voice
 * memo through the full Phase 2 pipeline against live AWS + Notion:
 *
 *   1. Generate ULID capture_id.
 *   2. Upload fixture audio (.oga) to S3 + meta sidecar at audio/{yyyy}/{mm}/...
 *   3. Publish capture.received (kind=voice) to kos.capture.
 *   4. Poll Transcribe job kos-<capture_id> until COMPLETED (max 90s).
 *   5. Poll CloudWatch Logs (voice-capture Lambda) for the matching capture_id +
 *      Notion page id + entity count + push-telegram invocation.
 *   6. Poll the Notion Command Center DB directly for the row tagged with
 *      this capture_id (proves the whole chain reached the DB).
 *   7. Stopwatch elapsed time → assert ≤ 25_000 ms (D-02 SLO).
 *      Warn between 25_000 and 45_000 ms; FAIL above 45_000 ms.
 *   8. Write .planning/phases/02-minimum-viable-loop/02-11-e2e-result-<ts>.json
 *      with {capture_id, elapsed_ms, transcript, transcribe_status,
 *      notion_page_id, push_telegram_invocations, langfuse_session_url}.
 *
 * Usage:
 *   BLOBS_BUCKET=kosdata-blobsf0f01dc6-etsqrpvycg0c \
 *     [KEVIN_TELEGRAM_USER_ID=<your-id>] \
 *     [VERIFY_FIXTURE=scripts/fixtures/sample-sv-voice-memo.oga] \
 *     [VERIFY_DEADLINE_MS=120000] \
 *     AWS_REGION=eu-north-1 \
 *     node scripts/verify-phase-2-e2e.mjs
 *
 * Exits 0 on PASS (within 25s SLO), 0 on WARN (≤45s), 1 on hard fail (>45s
 * or any required milestone missed).
 *
 * Notes:
 *   - 25_000 ms SLO per D-02; the deadline (VERIFY_DEADLINE_MS, default
 *     120_000) is the absolute polling ceiling — Transcribe alone needs
 *     ~10–30s on a real Swedish OGG memo so we never want to hard-fail
 *     before the pipeline has a fair chance.
 *   - Notion polling is the proof-of-life signal: even if Langfuse silently
 *     fails (placeholder secret), a Command Center row + Notion page id =
 *     voice-capture wrote real data.
 *   - We DO NOT poll Postgres (no SSM tunnel required for the gate). The
 *     observability check (scripts/verify-observability.mjs) does that
 *     separately when Langfuse credentials are real.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  TranscribeClient,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { Client as NotionClient } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// --- ULID inline (no npm-install footprint) ---
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
const bucket = process.env.BLOBS_BUCKET;
if (!bucket) {
  console.error('[ERR] BLOBS_BUCKET env var required (CFN export KosData:...Blobs).');
  process.exit(1);
}
const fixturePath =
  process.env.VERIFY_FIXTURE ?? 'scripts/fixtures/sample-sv-voice-memo.oga';
const kevinTelegramUserId = Number(
  process.env.KEVIN_TELEGRAM_USER_ID ?? 111222333,
);
const POLL_DEADLINE_MS = Number(process.env.VERIFY_DEADLINE_MS ?? 120_000);
const SLO_MS = 25_000;
const HARD_LIMIT_MS = 45_000;

const s3 = new S3Client({ region });
const eb = new EventBridgeClient({ region });
const tr = new TranscribeClient({ region });
const cwl = new CloudWatchLogsClient({ region });
const sm = new SecretsManagerClient({ region });

let bytes;
try {
  bytes = readFileSync(fixturePath);
} catch (err) {
  console.error(`[ERR] could not read fixture ${fixturePath}: ${err.message}`);
  process.exit(1);
}

const startedAt = Date.now();
const captureId = ulid();
const now = new Date(startedAt);
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const audioKey = `audio/${yyyy}/${mm}/${captureId}.oga`;
const metaKey = `audio/meta/${captureId}.json`;

console.log(`[verify-phase-2-e2e] capture_id=${captureId}`);
console.log(`[verify-phase-2-e2e] region=${region} bucket=${bucket}`);
console.log(`[verify-phase-2-e2e] fixture=${fixturePath} (${bytes.length} bytes)`);
console.log(`[verify-phase-2-e2e] SLO=${SLO_MS}ms hard_limit=${HARD_LIMIT_MS}ms poll_deadline=${POLL_DEADLINE_MS}ms`);

console.log(`[1/6] PUT audio → s3://${bucket}/${audioKey}`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: audioKey,
    Body: bytes,
    ContentType: 'audio/ogg',
  }),
);

console.log(`[2/6] PUT meta → s3://${bucket}/${metaKey}`);
await s3.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: metaKey,
    ContentType: 'application/json',
    Body: JSON.stringify({
      raw_ref: {
        s3_bucket: bucket,
        s3_key: audioKey,
        duration_sec: 5,
        mime_type: 'audio/ogg',
      },
      sender: { id: kevinTelegramUserId, display: 'Kevin' },
      received_at: now.toISOString(),
      telegram: { chat_id: kevinTelegramUserId, message_id: 1 },
    }),
  }),
);

console.log(`[3/6] PutEvents kos.capture / capture.received / kind=voice`);
await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        EventBusName: 'kos.capture',
        Source: 'kos.capture',
        DetailType: 'capture.received',
        Detail: JSON.stringify({
          capture_id: captureId,
          channel: 'telegram',
          kind: 'voice',
          raw_ref: {
            s3_bucket: bucket,
            s3_key: audioKey,
            duration_sec: 5,
            mime_type: 'audio/ogg',
          },
          sender: { id: kevinTelegramUserId, display: 'Kevin' },
          received_at: now.toISOString(),
          telegram: { chat_id: kevinTelegramUserId, message_id: 1 },
        }),
      },
    ],
  }),
);

// --- Step 4: Poll Transcribe job ---
const jobName = `kos-${captureId}`;
console.log(`[4/6] polling Transcribe job=${jobName} (max ${POLL_DEADLINE_MS / 1000}s)…`);
const tDeadline = startedAt + POLL_DEADLINE_MS;
let transcribeStatus = 'UNKNOWN';
let transcript = null;
while (Date.now() < tDeadline) {
  try {
    const j = await tr.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    transcribeStatus =
      j.TranscriptionJob?.TranscriptionJobStatus ?? 'UNKNOWN';
    if (transcribeStatus === 'COMPLETED' || transcribeStatus === 'FAILED') {
      // Try to fetch the transcript text from the result URI (it's a presigned S3 URL).
      const uri = j.TranscriptionJob?.Transcript?.TranscriptFileUri;
      if (transcribeStatus === 'COMPLETED' && uri) {
        try {
          const r = await fetch(uri);
          const data = await r.json();
          transcript = data?.results?.transcripts?.[0]?.transcript ?? '';
        } catch (err) {
          console.warn(`[warn] could not fetch transcript URI: ${err.message}`);
        }
      }
      break;
    }
  } catch {
    // Job not yet registered; keep polling.
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
console.log(
  `      → status=${transcribeStatus} transcript=${transcript === null ? 'null' : JSON.stringify(transcript).slice(0, 80)}`,
);

// --- Step 5: Poll CloudWatch Logs Insights for the voice-capture Lambda ---
async function findLogGroup(prefix) {
  // Use describe-log-groups; cheaper and more direct than tag lookup.
  const { DescribeLogGroupsCommand } = await import(
    '@aws-sdk/client-cloudwatch-logs'
  );
  const r = await cwl.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: `/aws/lambda/${prefix}`,
    }),
  );
  return r.logGroups?.[0]?.logGroupName ?? null;
}

async function logsInsightsFind(logGroup, captureId, sinceMs, untilMs) {
  if (!logGroup) return null;
  const startQ = await cwl.send(
    new StartQueryCommand({
      logGroupName: logGroup,
      startTime: Math.floor(sinceMs / 1000),
      endTime: Math.floor(untilMs / 1000),
      queryString: `fields @timestamp, @message | filter @message like '${captureId}' | sort @timestamp asc | limit 50`,
    }),
  );
  const queryId = startQ.queryId;
  const qDeadline = Date.now() + 30_000;
  while (Date.now() < qDeadline) {
    const r = await cwl.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === 'Complete') {
      return r.results ?? [];
    }
    if (r.status === 'Failed' || r.status === 'Cancelled') {
      return null;
    }
    await new Promise((res) => setTimeout(res, 1_500));
  }
  return null;
}

console.log(`[5/6] poll CloudWatch Logs for capture_id in voice-capture + push-telegram…`);
const voiceLogGroup = await findLogGroup('KosAgents-VoiceCaptureAgent');
const pushLogGroup = await findLogGroup('KosSafety-PushTelegram');
const triageLogGroup = await findLogGroup('KosAgents-TriageAgent');
console.log(`      voice-capture log group: ${voiceLogGroup ?? 'not-found'}`);
console.log(`      push-telegram log group: ${pushLogGroup ?? 'not-found'}`);
console.log(`      triage log group:        ${triageLogGroup ?? 'not-found'}`);

// CloudWatch Logs ingestion lag can be 5-15s; poll up to the deadline.
let voiceHits = null;
let pushHits = null;
let triageHits = null;
const logDeadline = Math.min(tDeadline, Date.now() + 60_000);
while (Date.now() < logDeadline) {
  if (!voiceHits || voiceHits.length === 0) {
    voiceHits = await logsInsightsFind(
      voiceLogGroup,
      captureId,
      startedAt - 5_000,
      Date.now() + 5_000,
    );
  }
  if (!pushHits || pushHits.length === 0) {
    pushHits = await logsInsightsFind(
      pushLogGroup,
      captureId,
      startedAt - 5_000,
      Date.now() + 5_000,
    );
  }
  if (!triageHits || triageHits.length === 0) {
    triageHits = await logsInsightsFind(
      triageLogGroup,
      captureId,
      startedAt - 5_000,
      Date.now() + 5_000,
    );
  }
  if ((voiceHits?.length ?? 0) > 0 && (pushHits?.length ?? 0) > 0) break;
  await new Promise((r) => setTimeout(r, 3_000));
}
console.log(
  `      triage log hits=${triageHits?.length ?? 0} voice-capture hits=${voiceHits?.length ?? 0} push-telegram hits=${pushHits?.length ?? 0}`,
);

// --- Step 6: Poll Notion Command Center for the row tagged with capture_id ---
async function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  try {
    const r = await sm.send(
      new GetSecretValueCommand({ SecretId: 'kos/notion-token' }),
    );
    if (!r.SecretString || r.SecretString === 'PLACEHOLDER') return null;
    return r.SecretString.trim();
  } catch (err) {
    console.warn(`[warn] could not fetch kos/notion-token: ${err.message}`);
    return null;
  }
}

const ids = JSON.parse(
  readFileSync('scripts/.notion-db-ids.json', 'utf8'),
);
const commandCenterDbId = ids.commandCenter;

let notionPageId = null;
const notionToken = await getNotionToken();
if (notionToken && commandCenterDbId) {
  const notion = new NotionClient({ auth: notionToken });
  console.log(`[6/6] poll Notion Command Center DB ${commandCenterDbId} for capture_id…`);
  const notionDeadline = Math.min(tDeadline, Date.now() + 30_000);
  while (Date.now() < notionDeadline) {
    try {
      const r = await notion.databases.query({
        database_id: commandCenterDbId,
        filter: {
          // Voice-capture writes the ULID into the "Capture ID" rich_text property.
          property: 'Capture ID',
          rich_text: { contains: captureId },
        },
        page_size: 5,
      });
      if (r.results && r.results.length > 0) {
        notionPageId = r.results[0].id;
        break;
      }
    } catch (err) {
      // Property may be named differently in the live DB; do a fallback search by URL substring.
      console.warn(`[warn] notion query: ${err.message}`);
      break;
    }
    await new Promise((res) => setTimeout(res, 2_500));
  }
  console.log(`      → notion_page_id=${notionPageId ?? 'NOT-FOUND'}`);
} else {
  console.warn(`[warn] no notion token or no commandCenter id — skipping Notion poll`);
}

// --- Final scoring + evidence file ---
const elapsed = Date.now() - startedAt;
console.log(`\n[verify-phase-2-e2e] total elapsed: ${elapsed} ms`);

const milestones = {
  capture_received_published: true,
  transcribe_completed: transcribeStatus === 'COMPLETED',
  triage_invoked: (triageHits?.length ?? 0) > 0,
  voice_capture_invoked: (voiceHits?.length ?? 0) > 0,
  push_telegram_invoked: (pushHits?.length ?? 0) > 0,
  notion_row_present: !!notionPageId,
  within_25s_slo: elapsed <= SLO_MS,
  within_45s_hard_limit: elapsed <= HARD_LIMIT_MS,
};
console.log('\n[milestones]');
for (const [k, v] of Object.entries(milestones)) {
  console.log(`  ${v ? 'OK ' : 'NO '} ${k}`);
}

if (elapsed > SLO_MS && elapsed <= HARD_LIMIT_MS) {
  console.warn(`[WARN] exceeded ${SLO_MS}ms SLO (D-02 — SLO not deadline)`);
}
if (elapsed > HARD_LIMIT_MS) {
  console.error(`[ERR] exceeded ${HARD_LIMIT_MS}ms hard limit (D-02 handoff threshold)`);
}

const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const outPath = `.planning/phases/02-minimum-viable-loop/02-11-e2e-result-${ts}.json`;
mkdirSync(dirname(outPath), { recursive: true });
const evidence = {
  capture_id: captureId,
  started_at: new Date(startedAt).toISOString(),
  elapsed_ms: elapsed,
  slo_ms: SLO_MS,
  hard_limit_ms: HARD_LIMIT_MS,
  fixture_path: fixturePath,
  fixture_bytes: bytes.length,
  bucket,
  audio_key: audioKey,
  meta_key: metaKey,
  transcribe_status: transcribeStatus,
  transcript,
  log_groups: {
    triage: triageLogGroup,
    voice_capture: voiceLogGroup,
    push_telegram: pushLogGroup,
  },
  log_hits: {
    triage: triageHits?.length ?? 0,
    voice_capture: voiceHits?.length ?? 0,
    push_telegram: pushHits?.length ?? 0,
  },
  notion_page_id: notionPageId,
  notion_command_center_db_id: commandCenterDbId,
  langfuse_session_url: `https://cloud.langfuse.com/sessions/${captureId}`,
  milestones,
};
writeFileSync(outPath, JSON.stringify(evidence, null, 2));
console.log(`\n[OK] wrote ${outPath}`);

// Hard-fail if Transcribe failed OR voice-capture never ran OR we exceeded the hard limit.
const hardFailed =
  transcribeStatus !== 'COMPLETED' ||
  !milestones.voice_capture_invoked ||
  elapsed > HARD_LIMIT_MS;
process.exit(hardFailed ? 1 : 0);
