#!/usr/bin/env node
/**
 * scripts/snapshot-n8n-workflows.mjs — Phase 10 Plan 10-05 / MIG-02 archive step.
 *
 * Operator-side n8n workflow + credential snapshotter. Runs BEFORE the
 * systemd stop in `decommission-n8n.sh` so the canonical-JSON SHA-256
 * archive is in S3 before we destroy the source.
 *
 * Why this script exists separately:
 *   - The n8n REST endpoint (`http://VPS:5678/rest/workflows`) is
 *     unauthenticated and accessible only from the VPS network namespace
 *     (or via SSH local port-forward).
 *   - The Phase 10-00 archiver Lambda
 *     (`services/n8n-workflow-archiver`) already implements the
 *     canonical-JSON + SHA-256 + KMS-encrypted PutObject path.
 *   - This script's job is therefore: fetch every workflow definition (and
 *     credentials list, names only, never the decrypted secrets) over the
 *     SSH tunnel, then invoke the archiver Lambda with the workflow array
 *     as payload. The Lambda owns canonicalization + hash + S3 PUT.
 *
 * Audit invariants (D-12 audit-first):
 *   - Writes one `event_log` row of kind 'n8n-workflows-archived' BEFORE
 *     the Lambda invocation, with detail.action='snapshot-begin'.
 *   - Writes one `event_log` row of kind 'n8n-workflows-archived' AFTER
 *     a successful Lambda invocation, with detail.action='snapshot-ok',
 *     detail.archived_count=N, and detail.s3_keys=[...].
 *   - On failure (HTTP error, Lambda error, audit insert error) → exit 1
 *     and DO NOT write a snapshot-ok row. The decommission script must
 *     refuse to proceed without snapshot-ok.
 *
 * Usage:
 *   node scripts/snapshot-n8n-workflows.mjs \
 *       --tunnel-port 15678 \
 *       --lambda-fn KosMigration-N8nWorkflowArchiver \
 *       --bucket kos-migration-archive-XXXXXX \
 *       --kms-key arn:aws:kms:eu-north-1:XXXX:key/XXXX \
 *       --prefix archive/n8n-workflows
 *
 *   node scripts/snapshot-n8n-workflows.mjs --dry-run     # network probe only
 *   node scripts/snapshot-n8n-workflows.mjs --help
 *
 * Env (read from process.env):
 *   RDS_URL                       psql DSN — required for audit rows
 *   AWS_REGION                    default eu-north-1
 *   N8N_TUNNEL_HOST               default 127.0.0.1 (localhost-forwarded port)
 *   N8N_ARCHIVER_FN               override --lambda-fn
 *   ARCHIVE_BUCKET_NAME           override --bucket
 *   KMS_KEY_ID                    override --kms-key
 *   KOS_OWNER_ID                  default 'kevin'
 *
 * Exit codes:
 *   0   snapshot uploaded; archived_count > 0
 *   1   any failure (network, lambda, audit)
 *   2   argument or env validation error
 *   3   n8n REST returned 0 workflows (suspicious — abort to be safe)
 *
 * Cf. .planning/phases/10-migration-decommission/10-05-DECOMMISSION-RUNBOOK.md
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Pull `require` for compatibility with any future CJS-only deps.
const require = createRequire(import.meta.url);
void require; // currently unused; kept for forward-compat

// ---------------------------------------------------------------------------
// Args + env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    tunnelHost: process.env.N8N_TUNNEL_HOST || '127.0.0.1',
    tunnelPort: 15678,
    lambdaFn: process.env.N8N_ARCHIVER_FN || '',
    bucket: process.env.ARCHIVE_BUCKET_NAME || '',
    kmsKey: process.env.KMS_KEY_ID || '',
    prefix: 'archive/n8n-workflows',
    ownerId: process.env.KOS_OWNER_ID || 'kevin',
    region: process.env.AWS_REGION || 'eu-north-1',
    dryRun: false,
    help: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const next = () => {
      const v = a[++i];
      if (v === undefined) {
        console.error(`[FAIL] ${k} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (k) {
      case '--tunnel-host': out.tunnelHost = next(); break;
      case '--tunnel-port': out.tunnelPort = Number(next()); break;
      case '--lambda-fn': out.lambdaFn = next(); break;
      case '--bucket': out.bucket = next(); break;
      case '--kms-key': out.kmsKey = next(); break;
      case '--prefix': out.prefix = next(); break;
      case '--owner-id': out.ownerId = next(); break;
      case '--region': out.region = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '-h':
      case '--help': out.help = true; break;
      default:
        console.error(`[FAIL] unknown arg: ${k}`);
        process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  console.log(
    [
      'snapshot-n8n-workflows.mjs — fetch every n8n workflow over SSH tunnel,',
      'invoke the n8n-workflow-archiver Lambda, write event_log audit rows.',
      '',
      'Usage:',
      '  node scripts/snapshot-n8n-workflows.mjs \\',
      '      --tunnel-port 15678 \\',
      '      --lambda-fn KosMigration-N8nWorkflowArchiver \\',
      '      --bucket kos-migration-archive-XXXXXX \\',
      '      --kms-key arn:aws:kms:eu-north-1:XXXX:key/XXXX \\',
      '      --prefix archive/n8n-workflows',
      '',
      'Options:',
      '  --tunnel-host <host>    default 127.0.0.1',
      '  --tunnel-port <port>    default 15678 (set up by decommission-n8n.sh)',
      '  --lambda-fn <name>      n8n-workflow-archiver Lambda function name',
      '  --bucket <name>         S3 archive bucket (KMS-encrypted)',
      '  --kms-key <arn|id>      KMS key for SSE-KMS',
      '  --prefix <s3-prefix>    default archive/n8n-workflows',
      '  --owner-id <id>         default kevin (for event_log row)',
      '  --region <aws-region>   default eu-north-1',
      '  --dry-run               probe + count only; no Lambda + no audit row',
      '  -h, --help              show this',
      '',
      'Required env: RDS_URL (audit-first invariant per D-12).',
      '',
      'Exits 0 on snapshot-ok, 1 on failure, 2 on bad args, 3 on zero workflows.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// HTTP fetcher (built-in fetch on Node 22 LTS)
// ---------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    // n8n with no proxy headers — use a short timeout so a hung VPS gets
    // surfaced fast.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return res.json();
}

/**
 * n8n REST returns either { data: [...] } (current) or [...] (older). Be
 * defensive — `unwrapList` returns an array regardless.
 */
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

async function fetchAllWorkflows(host, port) {
  const base = `http://${host}:${port}`;
  // Step 1 — list (id + name only)
  const listPayload = await getJson(`${base}/rest/workflows`);
  const list = unwrapList(listPayload);
  if (list.length === 0) return { list: [], full: [] };

  // Step 2 — full body per id (the list endpoint may omit `nodes`).
  const full = [];
  for (const stub of list) {
    const id = stub.id ?? stub.workflowId ?? stub._id;
    if (!id) {
      throw new Error(
        `n8n workflow stub without id field — cannot snapshot: ${JSON.stringify(stub)}`,
      );
    }
    const body = await getJson(`${base}/rest/workflows/${encodeURIComponent(id)}`);
    // n8n wraps the single-workflow response in { data: { ... } } in newer
    // versions and returns the bare object in older ones — normalize.
    const wf = body && typeof body === 'object' && 'data' in body && body.data
      ? body.data
      : body;
    if (!wf || typeof wf !== 'object' || !wf.id) {
      throw new Error(
        `n8n /rest/workflows/${id} returned malformed body — refusing to archive`,
      );
    }
    full.push(wf);
  }
  return { list, full };
}

/**
 * Fetch the credential metadata list (NEVER the decrypted secrets — n8n's
 * `/rest/credentials` returns shells with `data: undefined`; the actual
 * secret material stays in n8n's encryption-at-rest store, which we do
 * NOT extract). The list is captured so the operator audit trail records
 * which credential names existed at decom time, in case post-archival
 * re-keying is needed during a rollback.
 */
async function fetchCredentialList(host, port) {
  const base = `http://${host}:${port}`;
  try {
    const payload = await getJson(`${base}/rest/credentials`);
    const list = unwrapList(payload);
    return list.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
    }));
  } catch (err) {
    // Some n8n configs disable the credentials endpoint; treat as empty.
    console.warn(`[WARN] /rest/credentials probe failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// AWS Lambda invoke (via aws CLI to avoid pulling AWS SDK into root deps)
// ---------------------------------------------------------------------------

function invokeArchiverLambda({ region, lambdaFn, payload }) {
  const inFile = path.join(os.tmpdir(), `n8n-archive-in-${process.pid}.json`);
  const outFile = path.join(os.tmpdir(), `n8n-archive-out-${process.pid}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));

  const result = spawnSync(
    'aws',
    [
      'lambda', 'invoke',
      '--region', region,
      '--function-name', lambdaFn,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', `file://${inFile}`,
      outFile,
    ],
    { encoding: 'utf8' },
  );

  fs.rmSync(inFile, { force: true });

  if (result.status !== 0) {
    let body = '';
    try { body = fs.readFileSync(outFile, 'utf8'); } catch {}
    fs.rmSync(outFile, { force: true });
    throw new Error(
      `aws lambda invoke failed (exit=${result.status}): ${result.stderr.trim()}; body=${body}`,
    );
  }

  const body = fs.readFileSync(outFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Lambda response not JSON: ${body.slice(0, 200)}`);
  }
  if (parsed && parsed.errorType) {
    throw new Error(`Lambda raised ${parsed.errorType}: ${parsed.errorMessage}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Audit-first event_log writer (psql, matching scripts/retire-vps-script.sh)
// ---------------------------------------------------------------------------

function writeAuditRow({ rdsUrl, ownerId, detail, actor }) {
  // detail is a JS object — embed via psql --variable to dodge quoting hell.
  const json = JSON.stringify(detail).replace(/'/g, "''");
  const sql = `INSERT INTO event_log(owner_id, kind, detail, actor) VALUES ('${ownerId}', 'n8n-workflows-archived', '${json}'::jsonb, '${actor}');`;
  const result = spawnSync(
    'psql',
    [rdsUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `event_log insert failed (audit-first invariant): ${result.stderr.trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // Audit-first env validation. RDS_URL is mandatory for non-dry-run.
  if (!args.dryRun) {
    if (!process.env.RDS_URL) {
      console.error('[FAIL] RDS_URL env var required (audit-first per D-12)');
      process.exit(2);
    }
    if (!args.lambdaFn) {
      console.error('[FAIL] --lambda-fn or N8N_ARCHIVER_FN required');
      process.exit(2);
    }
    if (!args.bucket) {
      console.error('[FAIL] --bucket or ARCHIVE_BUCKET_NAME required');
      process.exit(2);
    }
    if (!args.kmsKey) {
      console.error('[FAIL] --kms-key or KMS_KEY_ID required');
      process.exit(2);
    }
  }

  const tsBegin = new Date().toISOString();
  console.log(
    `[INFO] snapshot begin host=${args.tunnelHost}:${args.tunnelPort} ` +
      `lambda=${args.lambdaFn || '(dry-run)'} bucket=${args.bucket || '(dry-run)'}`,
  );

  // 1) audit-begin row (skipped on dry-run)
  if (!args.dryRun) {
    writeAuditRow({
      rdsUrl: process.env.RDS_URL,
      ownerId: args.ownerId,
      actor: 'snapshot-n8n-workflows.mjs',
      detail: {
        action: 'snapshot-begin',
        tunnel_host: args.tunnelHost,
        tunnel_port: args.tunnelPort,
        lambda_fn: args.lambdaFn,
        bucket: args.bucket,
        prefix: args.prefix,
        ts: tsBegin,
      },
    });
    console.log('[OK]   event_log row written: snapshot-begin');
  } else {
    console.log('[DRY]  would write event_log snapshot-begin row');
  }

  // 2) fetch
  let workflows;
  let credentialNames;
  try {
    const fetched = await fetchAllWorkflows(args.tunnelHost, args.tunnelPort);
    workflows = fetched.full;
    credentialNames = await fetchCredentialList(args.tunnelHost, args.tunnelPort);
  } catch (err) {
    console.error(`[FAIL] n8n REST fetch failed: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `[INFO] fetched workflows=${workflows.length} credentials=${credentialNames.length}`,
  );

  if (workflows.length === 0) {
    console.error(
      '[FAIL] n8n /rest/workflows returned 0 workflows — refusing to proceed.\n' +
        '       Either the tunnel is wrong or n8n is already dead. Investigate manually.',
    );
    process.exit(3);
  }

  if (args.dryRun) {
    console.log(
      '[DRY]  would invoke ' + args.lambdaFn + ' with ' + workflows.length + ' workflow(s):',
    );
    for (const wf of workflows) {
      console.log('       - ' + wf.id + ' "' + (wf.name ?? '(unnamed)') + '"');
    }
    console.log('[OK-DRY] snapshot dry-run complete');
    process.exit(0);
  }

  // 3) invoke archiver Lambda — its handler does canonical-JSON + SHA-256 +
  //    SSE-KMS PutObject per workflow, returning { archived: [...] }.
  let lambdaResult;
  try {
    lambdaResult = invokeArchiverLambda({
      region: args.region,
      lambdaFn: args.lambdaFn,
      payload: {
        workflows,
        s3Prefix: args.prefix,
        bucketName: args.bucket,
        kmsKeyId: args.kmsKey,
      },
    });
  } catch (err) {
    console.error(`[FAIL] archiver Lambda invocation failed: ${err.message}`);
    process.exit(1);
  }

  const archived = Array.isArray(lambdaResult?.archived) ? lambdaResult.archived : [];
  if (archived.length !== workflows.length) {
    console.error(
      `[FAIL] archiver returned ${archived.length} rows but ${workflows.length} workflows fetched — partial archive`,
    );
    process.exit(1);
  }

  console.log(`[OK]   archived ${archived.length} workflow(s) to s3://${args.bucket}/${args.prefix}/`);
  for (const row of archived) {
    console.log(`       - ${row.workflow_id}  sha256=${row.sha256.slice(0, 16)}…  ${row.s3_key}`);
  }

  // 4) audit-ok row — closes the audit trail; decommission script reads
  //    this row to gate Stage 3 shutdown.
  writeAuditRow({
    rdsUrl: process.env.RDS_URL,
    ownerId: args.ownerId,
    actor: 'snapshot-n8n-workflows.mjs',
    detail: {
      action: 'snapshot-ok',
      archived_count: archived.length,
      bucket: args.bucket,
      prefix: args.prefix,
      s3_keys: archived.map((r) => r.s3_key),
      sha256_first16: archived.map((r) => ({ id: r.workflow_id, sha: r.sha256.slice(0, 16) })),
      credential_names: credentialNames.map((c) => c.name),
      ts_begin: tsBegin,
      ts_end: new Date().toISOString(),
    },
  });
  console.log('[OK]   event_log row written: snapshot-ok');
  console.log('[DONE] n8n snapshot complete — safe to proceed to systemctl stop.');
}

main().catch((err) => {
  console.error(`[FAIL] uncaught: ${err.stack || err.message}`);
  process.exit(1);
});
