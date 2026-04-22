#!/usr/bin/env node
/**
 * verify-observability.mjs — Plan 02-10 operator verification.
 *
 * After Kevin sends a real Telegram message and the pipeline completes:
 *   1. Asserts Langfuse cloud has at least one trace for the given capture_id
 *      (queried by Langfuse session.id since the agent Lambdas tag every
 *      span with capture_id → langfuse.session.id, see
 *      services/_shared/tracing.ts:tagTraceWithCaptureId).
 *   2. Optionally asserts a Sentry test event arrived in the last 60min
 *      (--check-sentry flag; requires SENTRY_AUTH_TOKEN env var).
 *
 * Usage:
 *   node scripts/verify-observability.mjs --capture-id 01HABCDEFGHJKMNPQRSTVWXYZ0
 *   node scripts/verify-observability.mjs --capture-id <ulid> --check-sentry
 *
 * Env:
 *   AWS_REGION                      (default eu-north-1; for Secrets Manager)
 *   LANGFUSE_BASE_URL               (default https://cloud.langfuse.com)
 *   SENTRY_ORG, SENTRY_PROJECT,
 *   SENTRY_AUTH_TOKEN               (required only with --check-sentry)
 *
 * Exits 0 on success, 1 on any failure. Designed to be CI-runnable after
 * a deploy-then-smoke-test sequence.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

function parseArgs() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.set(key, next);
        i += 1;
      } else {
        args.set(key, true);
      }
    }
  }
  return args;
}

async function getSecret(sm, secretId) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!r.SecretString || r.SecretString === 'PLACEHOLDER') {
    throw new Error(`Secret ${secretId} is empty or PLACEHOLDER`);
  }
  return r.SecretString.trim();
}

async function checkLangfuse(captureId, region) {
  const sm = new SecretsManagerClient({ region });
  const pub = await getSecret(sm, 'kos/langfuse-public-key');
  const sec = await getSecret(sm, 'kos/langfuse-secret-key');
  const auth = Buffer.from(`${pub}:${sec}`).toString('base64');
  const base = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
  // Langfuse REST: GET /api/public/traces?sessionId=<capture_id>
  // (capture_id is set as session.id by tagTraceWithCaptureId).
  const url = `${base}/api/public/traces?sessionId=${encodeURIComponent(captureId)}&limit=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Langfuse ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const count = (j.data ?? []).length;
  console.log(`[i] Langfuse traces for sessionId=${captureId}: ${count}`);
  if (count === 0) {
    throw new Error(
      'no Langfuse trace found — did the Lambda flush() before return? ' +
        'Check setupOtelTracing wiring + LANGFUSE_PUBLIC_KEY/SECRET_KEY env vars.',
    );
  }
  return count;
}

async function checkSentry() {
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!org || !project || !token) {
    throw new Error(
      'SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN must all be set for --check-sentry',
    );
  }
  // GET /api/0/projects/{org}/{project}/events/?statsPeriod=60m
  const url = `https://sentry.io/api/0/projects/${org}/${project}/events/?statsPeriod=60m`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sentry ${res.status}: ${body.slice(0, 200)}`);
  }
  const events = await res.json();
  const count = Array.isArray(events) ? events.length : 0;
  console.log(`[i] Sentry events in last 60min: ${count}`);
  if (count === 0) {
    throw new Error(
      'no Sentry events in last 60min — throw a test error in any Lambda and re-run',
    );
  }
  return count;
}

async function main() {
  const args = parseArgs();
  const captureId = args.get('capture-id');
  if (!captureId || captureId === true) {
    console.error(
      'Usage: verify-observability.mjs --capture-id <ulid> [--check-sentry]',
    );
    process.exit(1);
  }
  const region = process.env.AWS_REGION ?? 'eu-north-1';

  try {
    await checkLangfuse(captureId, region);
  } catch (err) {
    console.error(`[ERR] Langfuse check failed: ${err.message ?? err}`);
    process.exit(1);
  }

  if (args.get('check-sentry')) {
    try {
      await checkSentry();
    } catch (err) {
      console.error(`[ERR] Sentry check failed: ${err.message ?? err}`);
      process.exit(1);
    }
  }

  console.log('[OK] observability verified');
}

main().catch((err) => {
  console.error(`[ERR] unexpected: ${err.stack ?? err}`);
  process.exit(1);
});
