#!/usr/bin/env tsx
/**
 * sync-vercel-env.ts — Kevin-driven Vercel env var sync for kos-dashboard.
 *
 * Reads:
 *   1. CloudFormation stack `KosDashboard` outputs via DescribeStacks:
 *        - DashboardApiFunctionUrl   -> KOS_DASHBOARD_API_URL
 *        - RelayProxyFunctionUrl     -> KOS_DASHBOARD_RELAY_URL
 *   2. Secrets Manager (AWS region: eu-north-1):
 *        - kos/dashboard-bearer-token          -> KOS_DASHBOARD_BEARER_TOKEN
 *        - kos/dashboard-caller-access-keys    -> AWS_ACCESS_KEY_ID_DASHBOARD +
 *                                                 AWS_SECRET_ACCESS_KEY_DASHBOARD
 *        - kos/sentry-dsn-dashboard            -> NEXT_PUBLIC_SENTRY_DSN +
 *                                                 SENTRY_DSN
 *
 * Writes (via `vercel env rm` + `vercel env add`, production + preview +
 * development targets by default — override with --targets=prod,preview):
 *   KOS_DASHBOARD_API_URL, KOS_DASHBOARD_RELAY_URL,
 *   KOS_DASHBOARD_BEARER_TOKEN,
 *   AWS_ACCESS_KEY_ID_DASHBOARD, AWS_SECRET_ACCESS_KEY_DASHBOARD,
 *   AWS_REGION (=eu-north-1, hardcoded),
 *   KOS_OWNER_ID (hardcoded to Kevin's owner_id UUID — single-user contract),
 *   NEXT_PUBLIC_SENTRY_DSN, SENTRY_DSN.
 *
 * Flags:
 *   --dry-run            Print every change that WOULD be made; call no Vercel
 *                        mutation. Secret VALUES are never printed — only names
 *                        + lengths.
 *   --targets=prod,preview,development
 *                        Comma-separated Vercel environment targets. Default
 *                        all three.
 *   --yes                Skip the interactive confirmation prompt (for CI /
 *                        automation; Kevin's interactive flow defaults to
 *                        prompt).
 *   --project=<slug>     Override Vercel project slug (default: kos-dashboard).
 *                        The script must be run from a directory that has been
 *                        `vercel link`-ed to the target project OR the --project
 *                        flag must match the linked project; the `vercel` CLI
 *                        itself enforces this.
 *
 * Prerequisites (see .planning/phases/03-dashboard-mvp/03-DEPLOY-RUNBOOK.md):
 *   - AWS CLI authenticated to the KOS account (`aws sts get-caller-identity`).
 *   - Vercel CLI installed + `vercel login` completed as kevin-elzarka.
 *   - Current working directory linked to the kos-dashboard project
 *     (`cd apps/dashboard && vercel link --project kos-dashboard`).
 *   - All referenced secrets populated (NOT placeholders — script validates).
 *   - KosDashboard stack deployed (`cdk deploy KosDashboard`).
 *
 * Security:
 *   - Never prints secret values to stdout. Prints name + char-length + SHA-256
 *     first 6 hex chars (correlation-only; not reversible).
 *   - Uses `spawnSync` with explicit `stdio: 'pipe'` so the value piped on
 *     stdin never appears in shell history or process listings.
 *   - Hard-fails if any secret still contains the `{"placeholder": true}`
 *     sentinel from DashboardStack; runbook step 4 MUST be completed first.
 */

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ---- constants ----------------------------------------------------------

const REGION = 'eu-north-1';
const STACK_NAME = 'KosDashboard';
const KEVIN_OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const DEFAULT_PROJECT = 'kos-dashboard';
const DEFAULT_TARGETS = ['production', 'preview', 'development'] as const;

type VercelTarget = 'production' | 'preview' | 'development';

// ---- CLI arg parsing ----------------------------------------------------

interface Args {
  dryRun: boolean;
  targets: VercelTarget[];
  yes: boolean;
  project: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: false,
    targets: [...DEFAULT_TARGETS],
    yes: false,
    project: DEFAULT_PROJECT,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg.startsWith('--targets=')) {
      const raw = arg.slice('--targets='.length).split(',');
      const allowed: Record<string, VercelTarget> = {
        prod: 'production',
        production: 'production',
        preview: 'preview',
        dev: 'development',
        development: 'development',
      };
      const parsed = raw.map((r) => {
        const v = allowed[r.trim()];
        if (!v) {
          throw new Error(
            `--targets: unknown target "${r}"; allowed: prod|preview|dev`,
          );
        }
        return v;
      });
      out.targets = parsed;
    } else if (arg.startsWith('--project=')) {
      out.project = arg.slice('--project='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return out;
}

function printHelp(): void {
  stdout.write(
    [
      'sync-vercel-env.ts — sync AWS Secrets + CFN outputs -> Vercel env vars',
      '',
      'Usage: tsx scripts/sync-vercel-env.ts [flags]',
      '',
      'Flags:',
      '  --dry-run               Print what would change; no Vercel writes.',
      '  --yes, -y               Skip confirmation prompt.',
      '  --targets=<csv>         prod,preview,development (default: all three)',
      '  --project=<slug>        Vercel project slug (default: kos-dashboard)',
      '  --help, -h              This message.',
      '',
      'Safe by default: prompts before overwriting existing values.',
      'Never prints secret values — only name + length + SHA-256 prefix.',
      '',
    ].join('\n'),
  );
}

// ---- AWS readers --------------------------------------------------------

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });

async function readStackOutputs(): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const stack = res.Stacks?.[0];
  if (!stack) throw new Error(`CloudFormation stack ${STACK_NAME} not found`);
  const outputs: Record<string, string> = {};
  for (const o of stack.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) outputs[o.OutputKey] = o.OutputValue;
  }
  return outputs;
}

function requireOutput(outputs: Record<string, string>, key: string): string {
  const v = outputs[key];
  if (!v) {
    throw new Error(
      `CloudFormation stack ${STACK_NAME} is missing output "${key}". ` +
        `Did the latest cdk deploy complete?`,
    );
  }
  return v;
}

async function readSecret(secretId: string): Promise<string> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const v = res.SecretString;
  if (!v) throw new Error(`Secret ${secretId} has no SecretString`);
  // Hard guard: the DashboardStack seeds a '{"placeholder":true}' sentinel.
  // Runbook step 4 replaces each with the real value before sync.
  if (v.includes('"placeholder"')) {
    throw new Error(
      `Secret ${secretId} still contains the placeholder sentinel. ` +
        `Populate it per 03-DEPLOY-RUNBOOK.md step 4-6 first.`,
    );
  }
  return v;
}

// ---- vercel CLI wrappers ------------------------------------------------

interface VercelWriteResult {
  ok: boolean;
  target: VercelTarget;
  key: string;
  error?: string;
}

function vercelEnvRm(
  key: string,
  target: VercelTarget,
  project: string,
): { ok: boolean; notFound: boolean; stderr: string } {
  // `vercel env rm <name> <target> -y` exits 0 if removed, non-zero if not
  // present. We treat "not present" as success (idempotent).
  const res = spawnSync(
    'vercel',
    ['env', 'rm', key, target, '-y', '--scope', project],
    { encoding: 'utf-8', stdio: 'pipe' },
  );
  const stderr = String(res.stderr ?? '');
  const notFound =
    res.status !== 0 &&
    /(not found|does not exist|No environment variable)/i.test(stderr);
  return { ok: res.status === 0 || notFound, notFound, stderr };
}

function vercelEnvAdd(
  key: string,
  value: string,
  target: VercelTarget,
  project: string,
): VercelWriteResult {
  // `vercel env add <name> <target>` reads the value from stdin. We pipe it
  // via `input` so the value never appears on argv.
  const res = spawnSync(
    'vercel',
    ['env', 'add', key, target, '--scope', project],
    { input: `${value}\n`, encoding: 'utf-8', stdio: 'pipe' },
  );
  return {
    ok: res.status === 0,
    target,
    key,
    error:
      res.status === 0
        ? undefined
        : String(res.stderr ?? '').trim() || `exit=${res.status}`,
  };
}

function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

function previewLine(key: string, value: string): string {
  return `  ${key}  len=${value.length}  sha256:${secretFingerprint(value)}`;
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

// ---- main ---------------------------------------------------------------

interface EnvEntry {
  key: string;
  value: string;
  source: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  stdout.write(
    [
      '',
      '=== sync-vercel-env.ts ===',
      `  project:   ${args.project}`,
      `  targets:   ${args.targets.join(', ')}`,
      `  dry-run:   ${args.dryRun ? 'YES' : 'no'}`,
      `  region:    ${REGION}`,
      `  stack:     ${STACK_NAME}`,
      '',
    ].join('\n'),
  );

  // 1. Read CFN outputs.
  stdout.write('Reading CloudFormation outputs...\n');
  const outputs = await readStackOutputs();
  const dashboardApiUrl = requireOutput(outputs, 'DashboardApiFunctionUrl');
  const relayProxyUrl = requireOutput(outputs, 'RelayProxyFunctionUrl');

  // 2. Read Secrets.
  stdout.write('Reading Secrets Manager secrets...\n');
  const bearerRaw = await readSecret('kos/dashboard-bearer-token');
  const callerRaw = await readSecret('kos/dashboard-caller-access-keys');
  const sentryRaw = await readSecret('kos/sentry-dsn-dashboard');

  // Parse bearer (accepts either `{"token":"..."}` or a raw string).
  let bearer: string;
  try {
    const parsed = JSON.parse(bearerRaw);
    bearer =
      typeof parsed === 'string'
        ? parsed
        : typeof parsed?.token === 'string'
          ? parsed.token
          : bearerRaw;
  } catch {
    bearer = bearerRaw.trim();
  }
  if (!bearer || bearer.length < 16) {
    throw new Error(
      'kos/dashboard-bearer-token: parsed token is empty or < 16 chars. ' +
        'Generate one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` ' +
        'and store as `{"token":"<value>"}`.',
    );
  }

  // Parse caller keys (`aws iam create-access-key` JSON shape).
  const callerParsed = JSON.parse(callerRaw);
  const accessKeyId =
    callerParsed?.AccessKey?.AccessKeyId ?? callerParsed?.AccessKeyId;
  const secretAccessKey =
    callerParsed?.AccessKey?.SecretAccessKey ?? callerParsed?.SecretAccessKey;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'kos/dashboard-caller-access-keys: expected {AccessKey:{AccessKeyId,SecretAccessKey}} ' +
        'or flat {AccessKeyId,SecretAccessKey}. Run `aws iam create-access-key ' +
        '--user-name kos-dashboard-caller` and re-store.',
    );
  }

  // Sentry DSN is a URL, not JSON. Tolerate both shapes.
  let sentryDsn = sentryRaw;
  try {
    const parsed = JSON.parse(sentryRaw);
    if (typeof parsed === 'string') sentryDsn = parsed;
    else if (typeof parsed?.dsn === 'string') sentryDsn = parsed.dsn;
  } catch {
    // Already a bare DSN string.
  }
  sentryDsn = sentryDsn.trim();
  if (!/^https?:\/\//.test(sentryDsn)) {
    throw new Error(
      'kos/sentry-dsn-dashboard: expected a URL (https://...@sentry.io/...). ' +
        'Copy from Sentry project settings and re-store.',
    );
  }

  // 3. Assemble the env set.
  const entries: EnvEntry[] = [
    {
      key: 'KOS_DASHBOARD_API_URL',
      value: dashboardApiUrl,
      source: 'CFN:DashboardApiFunctionUrl',
    },
    {
      key: 'KOS_DASHBOARD_RELAY_URL',
      value: relayProxyUrl,
      source: 'CFN:RelayProxyFunctionUrl',
    },
    {
      key: 'KOS_DASHBOARD_BEARER_TOKEN',
      value: bearer,
      source: 'Secret:kos/dashboard-bearer-token',
    },
    {
      key: 'AWS_ACCESS_KEY_ID_DASHBOARD',
      value: accessKeyId,
      source: 'Secret:kos/dashboard-caller-access-keys',
    },
    {
      key: 'AWS_SECRET_ACCESS_KEY_DASHBOARD',
      value: secretAccessKey,
      source: 'Secret:kos/dashboard-caller-access-keys',
    },
    { key: 'AWS_REGION', value: REGION, source: 'hardcoded' },
    { key: 'KOS_OWNER_ID', value: KEVIN_OWNER_ID, source: 'hardcoded' },
    {
      key: 'NEXT_PUBLIC_SENTRY_DSN',
      value: sentryDsn,
      source: 'Secret:kos/sentry-dsn-dashboard',
    },
    {
      key: 'SENTRY_DSN',
      value: sentryDsn,
      source: 'Secret:kos/sentry-dsn-dashboard',
    },
  ];

  stdout.write(`\nResolved ${entries.length} env var(s):\n`);
  for (const e of entries) stdout.write(previewLine(e.key, e.value) + `  <= ${e.source}\n`);
  stdout.write(`\nTarget environments: ${args.targets.join(', ')}\n`);
  const totalWrites = entries.length * args.targets.length;
  stdout.write(`Total planned Vercel writes: ${totalWrites}\n\n`);

  if (args.dryRun) {
    stdout.write('DRY RUN — no Vercel mutations performed.\n');
    return;
  }

  if (!args.yes) {
    const ok = await confirm(
      `About to overwrite ${totalWrites} env values on Vercel project "${args.project}". Proceed?`,
    );
    if (!ok) {
      stdout.write('Aborted by user.\n');
      process.exit(2);
    }
  }

  // 4. Execute: rm + add per (entry, target).
  let successes = 0;
  const failures: VercelWriteResult[] = [];
  for (const entry of entries) {
    for (const target of args.targets) {
      const rm = vercelEnvRm(entry.key, target, args.project);
      if (!rm.ok && !rm.notFound) {
        failures.push({
          ok: false,
          target,
          key: entry.key,
          error: `rm failed: ${rm.stderr.trim()}`,
        });
        continue;
      }
      const add = vercelEnvAdd(entry.key, entry.value, target, args.project);
      if (add.ok) {
        successes++;
        stdout.write(`  [OK]   ${entry.key} @ ${target}\n`);
      } else {
        failures.push(add);
        stdout.write(`  [FAIL] ${entry.key} @ ${target}: ${add.error}\n`);
      }
    }
  }

  stdout.write(
    `\nDone. Success: ${successes}/${totalWrites}. Failures: ${failures.length}.\n`,
  );
  if (failures.length > 0) {
    stdout.write(
      `\nFailed writes (review + re-run, or fix via Vercel dashboard):\n`,
    );
    for (const f of failures) {
      stdout.write(`  ${f.key} @ ${f.target}: ${f.error ?? 'unknown'}\n`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nsync-vercel-env.ts: ${msg}\n`);
  process.exit(1);
});
