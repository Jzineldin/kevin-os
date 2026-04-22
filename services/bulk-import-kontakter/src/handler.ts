/**
 * @kos/service-bulk-import-kontakter — Plan 02-08 (ENT-05 / D-22 / D-24).
 *
 * One-shot Lambda that reads every row from Kevin's Kontakter Notion DB and
 * writes one KOS Inbox Pending row per novel contact. Two-tier dedup:
 *   (a) KOS Inbox by normalised proposed name (skip if already there in
 *       Pending / Approved / Merged status — Rejected lets the row come back)
 *   (b) entity_index by normalised name OR alias (Kevin already has the
 *       contact as a real Entities-DB page — no Inbox row needed)
 *
 * Embeddings are NOT written here. Rationale: most Kontakter rows are
 * candidates for rejection (Kevin's old contacts list contains throwaway
 * names). Embedding all of them wastes tokens. Plan 02-08 Task 2 extends the
 * notion-indexer's entities upsert path to embed each Approved entity once
 * Kevin flips its Inbox row to Approved → indexer creates the Entities-DB
 * page → next entities-DB tick embeds it.
 *
 * Embed-profile discovery (Open Question 2 runbook): on cold start, calls
 * `bedrock:ListInferenceProfiles` and logs whether an `eu.*cohere.embed-
 * multilingual-v3` profile exists. The profile ID is logged but NOT used
 * here — Task 2's indexer is the only consumer. If absent, indexer falls
 * back to base `cohere.embed-multilingual-v3` (cross-region us-east-1; GDPR
 * note in SUMMARY).
 */

import { init as sentryInit, wrapHandler } from '@sentry/aws-serverless';
import { Client as NotionClient, type Client } from '@notionhq/client';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import {
  discoverKontakterDbId,
  readKontakter,
  mapKontakterToInboxInput,
} from './kontakter.js';
import {
  getInboxClient,
  normaliseName,
  findApprovedPendingOrMergedInbox,
  createInboxRow,
} from './inbox.js';

sentryInit({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0, sampleRate: 1 });
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let cachedPool: PgPool | null = null;
let bedrockProfileLogged = false;

async function getPool(): Promise<PgPool> {
  if (cachedPool) return cachedPool;
  const host = process.env.RDS_PROXY_ENDPOINT;
  const user = process.env.RDS_IAM_USER;
  if (!host) throw new Error('RDS_PROXY_ENDPOINT not set');
  if (!user) throw new Error('RDS_IAM_USER not set');
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const signer = new Signer({ hostname: host, port: 5432, region, username: user });
  cachedPool = new Pool({
    host,
    port: 5432,
    user,
    database: 'kos',
    ssl: { rejectUnauthorized: false },
    password: async () => signer.getAuthToken(),
    max: 2,
    idleTimeoutMillis: 10_000,
  } as never);
  return cachedPool;
}

/**
 * Embed-profile discovery breadcrumb. The actual `bedrock:ListInferenceProfiles`
 * call is delegated to `scripts/discover-bedrock-embed-profile.sh` (operator
 * runbook, Open Question 2 resolution) — runtime SDK call removed to avoid
 * pulling the @aws-sdk/client-bedrock control-plane SDK into the Lambda
 * bundle (deviation Rule 3: that package is not yet installed in the
 * monorepo's pnpm-lock; adding it would require a separate dependency
 * approval). The Lambda's only role is to log the runbook hint on cold start.
 */
async function logBedrockEmbedProfile(): Promise<void> {
  if (bedrockProfileLogged) return;
  bedrockProfileLogged = true;
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  console.log(
    `[bulk-kontakter] Embed-profile discovery is operator-driven: run ` +
      `\`scripts/discover-bedrock-embed-profile.sh\` (region=${region}) to ` +
      `check for an eu.*cohere.embed-multilingual-v3 inference profile. ` +
      `Indexer (Task 2) honours COHERE_EMBED_MODEL_ID env override; if absent ` +
      `it uses the base model ID (cross-region us-east-1; GDPR-acceptable per A1).`,
  );
}

// Sleep helper used for Notion rate-limiting (≤3 rps).
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function yyyymmdd(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export interface RunImportEvent {
  /** Don't actually create rows — just count what would be created. */
  dryRun?: boolean;
  /** Cap the number of rows processed (mostly for tests + smoke runs). */
  limit?: number;
}

export interface RunImportResult {
  total: number;
  created: number;
  skippedInboxDup: number;
  skippedEntityDup: number;
  errors: number;
}

export interface RunImportDeps {
  notion: Client;
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };
  kosInboxId: string;
  /** If absent, runImport calls discoverKontakterDbId. */
  kontakterDbId?: string;
}

/**
 * Pure-function core (DI-friendly for tests). Performs the read → dedup →
 * createInboxRow loop. Returns counters.
 *
 * Rate-limit: a 350ms sleep between every successful createInboxRow keeps us
 * comfortably below Notion's 3 rps page-create cap (A4 in CONTEXT). Dedup
 * checks are read-only and don't count against the create budget.
 */
export async function runImport(
  event: RunImportEvent,
  deps: RunImportDeps,
): Promise<RunImportResult> {
  const { notion, pool, kosInboxId } = deps;
  const dryRun = event.dryRun === true;
  const limit = event.limit ?? Infinity;

  // Resolve Kontakter DB ID — env override > injected dep > notion.search
  const kontakterDbId =
    deps.kontakterDbId ??
    process.env.KONTAKTER_DB_ID ??
    (await discoverKontakterDbId(notion));

  const captureIdPrefix = `bulk-kontakter-${yyyymmdd()}`;

  const counters: RunImportResult = {
    total: 0,
    created: 0,
    skippedInboxDup: 0,
    skippedEntityDup: 0,
    errors: 0,
  };

  for await (const row of readKontakter(notion, kontakterDbId)) {
    if (counters.total >= limit) break;
    counters.total += 1;
    try {
      const input = mapKontakterToInboxInput(row);
      const norm = normaliseName(input.proposedName);

      // (a) Inbox dedup
      const lookup = await findApprovedPendingOrMergedInbox(
        notion,
        kosInboxId,
        input.proposedName,
      );
      if (lookup.approvedPageId || lookup.pendingPageId || lookup.mergedPageId) {
        counters.skippedInboxDup += 1;
        continue;
      }

      // (b) entity_index dedup — normalised name OR alias match
      const ent = await pool.query(
        `SELECT 1 FROM entity_index
          WHERE LOWER(name) = $1
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = $1)
          LIMIT 1`,
        [norm],
      );
      if ((ent.rowCount ?? 0) > 0) {
        counters.skippedEntityDup += 1;
        continue;
      }

      counters.created += 1;
      if (!dryRun) {
        await createInboxRow({
          client: notion,
          kosInboxId,
          proposedName: input.proposedName,
          candidateType: 'Person',
          sourceCaptureId: captureIdPrefix,
          confidence: 0,
          rawContext: input.rawContext,
        });
        // Notion rate-limit: ≤3 rps creates → 350ms inter-create pacing.
        await sleep(350);
      }
    } catch (err) {
      counters.errors += 1;
      console.warn(
        `[bulk-kontakter] row ${row.id} (${row.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Best-effort summary into event_log so Plan 02-11 e2e can verify.
  try {
    await pool.query(
      `INSERT INTO event_log (kind, detail)
       VALUES ('bulk-kontakter-import', jsonb_build_object(
         'total', $1::int,
         'created', $2::int,
         'skipped_inbox_dup', $3::int,
         'skipped_entity_dup', $4::int,
         'errors', $5::int,
         'dry_run', $6::boolean,
         'capture_id_prefix', $7::text,
         'completed_at', now()
       ))`,
      [
        counters.total,
        counters.created,
        counters.skippedInboxDup,
        counters.skippedEntityDup,
        counters.errors,
        dryRun,
        captureIdPrefix,
      ],
    );
  } catch (err) {
    // Non-fatal; counters still returned.
    console.warn(
      `[bulk-kontakter] event_log insert failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(
    `[bulk-kontakter] complete (dryRun=${dryRun}): ${JSON.stringify(counters)}`,
  );
  return counters;
}

/**
 * Lambda entry point. Resolves dependencies (Notion client + RDS pool +
 * KOS Inbox ID) then delegates to runImport.
 */
export const handler = wrapHandler(async (event: RunImportEvent = {}) => {
  await logBedrockEmbedProfile();

  const { client, kosInboxId } = await getInboxClient();
  const pool = await getPool();
  // Build a separate Notion client iff not already cached — getInboxClient's
  // client is bound to the same token, so reuse it for both Inbox + Kontakter
  // reads.
  const notion: Client = client as unknown as NotionClient;

  return runImport(event, {
    notion,
    pool: pool as unknown as RunImportDeps['pool'],
    kosInboxId,
  });
});
