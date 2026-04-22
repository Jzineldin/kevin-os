/**
 * @kos/service-bulk-import-granola-gmail — Plan 02-09 (ENT-06 / D-23 / D-24).
 *
 * One-shot operator-invoked Lambda that completes the bulk-import leg of
 * Phase 2. Reads:
 *   - Granola transcripts via the Notion **Transkripten** DB (Resolved Open
 *     Question 1 — NOT via Granola REST), last 90 days by `last_edited_time`.
 *   - Gmail From: headers + 200-char snippets via OAuth (`gmail.readonly`),
 *     last 90 days, kevin@tale-forge.app account.
 *
 * Per-source extracts run through `extractPersonCandidates`, then a shared
 * cross-source dedup Set collapses Henrik-in-both-sources → 1 candidate
 * (provenance bumped to `both`). Each surviving candidate is dual-checked
 * against KOS Inbox (Pending/Approved/Merged skip) + entity_index (normalised
 * name OR alias hit skip), then a single `createInboxRow` lands a Pending
 * row with `[source=…]` provenance prefix.
 *
 * Graceful partial: if Gmail OAuth secret missing, skip Gmail leg + log warn.
 * If Transkripten DB missing, skip Granola leg + log warn. Counters report
 * which leg ran.
 *
 * Plan 08 patterns reused verbatim: 350ms inter-create sleep (≤3 rps Notion
 * cap, A4 in CONTEXT), event_log summary insert at end, runImport pure-
 * function core (DI-friendly for tests).
 */

import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { Client as NotionClient, type Client } from '@notionhq/client';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import {
  discoverTranskriptenDbId,
  readTranskripten,
} from './granola.js';
import {
  buildGmailClient,
  readGmailSignatures,
  type GmailFromMessage,
} from './gmail.js';
import {
  extractPersonCandidates,
  type PersonCandidate,
} from './extract.js';
import {
  getInboxClient,
  normaliseName,
  findApprovedPendingOrMergedInbox,
  createInboxRow,
} from './inbox.js';
import type { gmail_v1 } from 'googleapis';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

let cachedPool: PgPool | null = null;

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
  /** Default 'both'. Skip a leg if 'granola' or 'gmail'. */
  sources?: 'granola' | 'gmail' | 'both';
  /** Cap candidates processed (mostly for tests + smoke runs). */
  limit?: number;
  /** Override 90-day default window. */
  daysBack?: number;
}

export interface RunImportResult {
  totalGranola: number;
  totalGmail: number;
  candidatesUnique: number;
  created: number;
  skippedInboxDup: number;
  skippedEntityDup: number;
  skippedDup: number;
  errors: number;
  granolaSkipped: boolean;
  gmailSkipped: boolean;
}

export interface CandidateBag {
  /** Map keyed by normalisedName → first-seen candidate (provenance promotes to 'both'). */
  byName: Map<string, { c: PersonCandidate; sources: Set<'granola' | 'gmail'> }>;
}

function bagAdd(
  bag: CandidateBag,
  c: PersonCandidate,
  source: 'granola' | 'gmail',
): void {
  const key = normaliseName(c.name);
  if (!key) return;
  const existing = bag.byName.get(key);
  if (!existing) {
    bag.byName.set(key, { c, sources: new Set([source]) });
    return;
  }
  existing.sources.add(source);
  // Upgrade to higher-confidence candidate if newcomer is HIGH and existing
  // is MEDIUM. Keeps signature/header context_snippet.
  if (c.confidence === 'high' && existing.c.confidence !== 'high') {
    existing.c = c;
  }
}

export interface RunImportDeps {
  notion: Client;
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };
  kosInboxId: string;
  /** If absent + sources≠'gmail-only', runImport calls discoverTranskriptenDbId. */
  transkriptenDbId?: string;
  /** Pre-built Gmail client (test injection). If absent, runImport calls buildGmailClient. */
  gmail?: gmail_v1.Gmail | null;
  /** Override the readers (test injection). */
  readTranskriptenFn?: (notion: Client, dbId: string, daysBack: number) => AsyncIterable<{ id: string; title: string; bodyText: string }>;
  readGmailFn?: (gmail: gmail_v1.Gmail, daysBack: number) => AsyncIterable<GmailFromMessage>;
}

/**
 * Pure-function core. Read Granola + Gmail → extract → cross-source dedup →
 * Inbox/entity_index dedup → createInboxRow with `[source=…]` provenance.
 */
export async function runImport(
  event: RunImportEvent,
  deps: RunImportDeps,
): Promise<RunImportResult> {
  const { notion, pool, kosInboxId } = deps;
  const dryRun = event.dryRun === true;
  const limit = event.limit ?? Infinity;
  const daysBack = event.daysBack ?? 90;
  const sources = event.sources ?? 'both';

  const captureIdPrefix = `bulk-ent06-${yyyymmdd()}`;
  const counters: RunImportResult = {
    totalGranola: 0,
    totalGmail: 0,
    candidatesUnique: 0,
    created: 0,
    skippedInboxDup: 0,
    skippedEntityDup: 0,
    skippedDup: 0,
    errors: 0,
    granolaSkipped: false,
    gmailSkipped: false,
  };

  const bag: CandidateBag = { byName: new Map() };

  // ---- Granola leg --------------------------------------------------------
  const wantGranola = sources === 'both' || sources === 'granola';
  if (wantGranola) {
    try {
      const dbId =
        deps.transkriptenDbId ??
        process.env.TRANSKRIPTEN_DB_ID ??
        (await discoverTranskriptenDbId(notion));
      const reader = deps.readTranskriptenFn
        ? deps.readTranskriptenFn(notion, dbId, daysBack)
        : readTranskripten(notion, dbId, daysBack);
      for await (const row of reader) {
        counters.totalGranola += 1;
        const text = `${row.title}\n${row.bodyText}`;
        const before = bag.byName.size;
        for (const c of extractPersonCandidates(text)) {
          bagAdd(bag, c, 'granola');
        }
        // Light backpressure (non-essential — Notion read pagination handles
        // it, but keeps the log readable on long Transkripten DBs).
        if (bag.byName.size - before > 0 && bag.byName.size % 50 === 0) {
          console.log(
            `[bulk-ent06] granola progress: ${counters.totalGranola} rows scanned, ${bag.byName.size} unique candidates`,
          );
        }
      }
    } catch (err) {
      counters.granolaSkipped = true;
      console.warn(
        `[bulk-ent06] Granola/Transkripten leg skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    counters.granolaSkipped = true;
  }

  // ---- Gmail leg ----------------------------------------------------------
  const wantGmail = sources === 'both' || sources === 'gmail';
  if (wantGmail) {
    try {
      // gmail===null means test explicitly opted out
      const gmail =
        deps.gmail === null
          ? null
          : deps.gmail ?? (await buildGmailClient());
      if (!gmail) {
        counters.gmailSkipped = true;
      } else {
        const reader = deps.readGmailFn
          ? deps.readGmailFn(gmail, daysBack)
          : readGmailSignatures(gmail, daysBack);
        for await (const msg of reader) {
          counters.totalGmail += 1;
          // Treat the From header line as text the extractor can read.
          const text = `From: ${msg.from}\n${msg.snippet}`;
          for (const c of extractPersonCandidates(text)) {
            bagAdd(bag, c, 'gmail');
          }
        }
      }
    } catch (err) {
      counters.gmailSkipped = true;
      console.warn(
        `[bulk-ent06] Gmail leg skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    counters.gmailSkipped = true;
  }

  counters.candidatesUnique = bag.byName.size;

  // ---- Per-candidate dedup + create ---------------------------------------
  let processed = 0;
  for (const [norm, entry] of bag.byName) {
    if (processed >= limit) break;
    processed += 1;
    try {
      const provenance: 'granola' | 'gmail' | 'both' =
        entry.sources.has('granola') && entry.sources.has('gmail')
          ? 'both'
          : entry.sources.has('granola')
          ? 'granola'
          : 'gmail';

      // (a) KOS Inbox dedup
      const lookup = await findApprovedPendingOrMergedInbox(
        notion,
        kosInboxId,
        entry.c.name,
      );
      if (lookup.approvedPageId || lookup.pendingPageId || lookup.mergedPageId) {
        counters.skippedInboxDup += 1;
        counters.skippedDup += 1;
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
        counters.skippedDup += 1;
        continue;
      }

      counters.created += 1;
      if (!dryRun) {
        await createInboxRow({
          client: notion,
          kosInboxId,
          proposedName: entry.c.name,
          candidateType: 'Person',
          sourceCaptureId: captureIdPrefix,
          confidence: 0,
          provenance,
          rawContext: entry.c.context_snippet,
        });
        await sleep(350);
      }
    } catch (err) {
      counters.errors += 1;
      console.warn(
        `[bulk-ent06] candidate "${entry.c.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- event_log summary --------------------------------------------------
  try {
    await pool.query(
      `INSERT INTO event_log (kind, detail)
       VALUES ('bulk-ent06-import', jsonb_build_object(
         'total_granola', $1::int,
         'total_gmail', $2::int,
         'candidates_unique', $3::int,
         'created', $4::int,
         'skipped_inbox_dup', $5::int,
         'skipped_entity_dup', $6::int,
         'errors', $7::int,
         'dry_run', $8::boolean,
         'capture_id_prefix', $9::text,
         'granola_skipped', $10::boolean,
         'gmail_skipped', $11::boolean,
         'completed_at', now()
       ))`,
      [
        counters.totalGranola,
        counters.totalGmail,
        counters.candidatesUnique,
        counters.created,
        counters.skippedInboxDup,
        counters.skippedEntityDup,
        counters.errors,
        dryRun,
        captureIdPrefix,
        counters.granolaSkipped,
        counters.gmailSkipped,
      ],
    );
  } catch (err) {
    console.warn(
      `[bulk-ent06] event_log insert failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(
    `[bulk-ent06] complete (dryRun=${dryRun}): ${JSON.stringify(counters)}`,
  );
  return counters;
}

/**
 * Lambda entry point. Resolves Notion + RDS pool + KOS Inbox + Gmail then
 * delegates to runImport.
 */
export const handler = wrapHandler(async (event: RunImportEvent = {}) => {
  await initSentry();
  // Synthetic capture_id per Plan 02-10 — keeps Langfuse session view tidy.
  tagTraceWithCaptureId(`bulk-ent06-${yyyymmdd()}`);
  const { client, kosInboxId } = await getInboxClient();
  const pool = await getPool();
  const notion: Client = client as unknown as NotionClient;

  return runImport(event, {
    notion,
    pool: pool as unknown as RunImportDeps['pool'],
    kosInboxId,
  });
});
