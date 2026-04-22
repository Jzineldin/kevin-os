/**
 * KOS Inbox helpers for bulk-import-granola-gmail (Plan 02-09).
 *
 * Mirrors `services/bulk-import-kontakter/src/inbox.ts` (Plan 02-08) — same
 * normaliseName, same dual-read (Pending+Approved+Merged skip, Rejected
 * allow-re-import). Exists as its own copy in this service so the two bulk-
 * import Lambdas remain independently deployable; if a third bulk-import
 * lands later, this is the right moment to extract a shared package.
 *
 * Differences vs Plan 08:
 *   - source_capture_id is `bulk-ent06-${yyyymmdd}` (granola+gmail combined).
 *   - createInboxRow accepts a `provenance` field (granola | gmail | both)
 *     that prefixes the Raw Context (must_haves: source provenance on each
 *     created Inbox row).
 */

import { Client } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

let cached: { client: Client; kosInboxId: string } | null = null;

export async function getInboxClient(): Promise<{
  client: Client;
  kosInboxId: string;
}> {
  if (cached) return cached;

  let kosInboxId = process.env.NOTION_KOS_INBOX_DB_ID;
  if (!kosInboxId) {
    const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
    const idsPath =
      process.env.NOTION_DB_IDS_PATH ?? join(root, 'notion-db-ids.json');
    try {
      const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { kosInbox?: string };
      if (ids.kosInbox) kosInboxId = ids.kosInbox;
    } catch {
      // fall through
    }
  }
  if (!kosInboxId) {
    throw new Error(
      'NOTION_KOS_INBOX_DB_ID not set and notion-db-ids.json missing kosInbox key (Plan 02-07 bootstrap must run first)',
    );
  }

  let token = process.env.NOTION_TOKEN;
  if (!token) {
    const arn = process.env.NOTION_TOKEN_SECRET_ARN;
    if (!arn) throw new Error('NOTION_TOKEN or NOTION_TOKEN_SECRET_ARN must be set');
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    token = r.SecretString ?? '';
    if (!token || token === 'PLACEHOLDER') {
      throw new Error('NOTION_TOKEN secret is empty or PLACEHOLDER');
    }
  }

  cached = { client: new Client({ auth: token }), kosInboxId };
  return cached;
}

/** Normalise a name for comparison: lowercase + trim + NFD-strip-marks + collapse-spaces. */
export function normaliseName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface InboxLookup {
  approvedPageId?: string;
  pendingPageId?: string;
  mergedPageId?: string;
}

/**
 * Mirrors Plan 02-08 dual-read. Returns first Approved + Pending + Merged
 * hit by normalised name. Filters out Rejected (allow re-import).
 */
export async function findApprovedPendingOrMergedInbox(
  client: Client,
  kosInboxId: string,
  proposedName: string,
): Promise<InboxLookup> {
  const wanted = normaliseName(proposedName);
  const res = await client.databases.query({
    database_id: kosInboxId,
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: 'Rejected' } },
        { property: 'Proposed Entity Name', title: { contains: proposedName.slice(0, 80) } },
      ],
    },
    page_size: 50,
  });
  const out: InboxLookup = {};
  for (const row of res.results as Array<{ id: string; properties: Record<string, unknown> }>) {
    const title =
      (row.properties['Proposed Entity Name'] as { title?: Array<{ plain_text: string }> })
        ?.title?.[0]?.plain_text ?? '';
    if (normaliseName(title) !== wanted) continue;
    const status = (row.properties.Status as { select?: { name: string } })?.select?.name;
    if (status === 'Approved' && !out.approvedPageId) out.approvedPageId = row.id;
    if (status === 'Pending' && !out.pendingPageId) out.pendingPageId = row.id;
    if (status === 'Merged' && !out.mergedPageId) out.mergedPageId = row.id;
  }
  return out;
}

export interface CreateInboxRowInput {
  client: Client;
  kosInboxId: string;
  proposedName: string;
  candidateType: 'Person' | 'Project' | 'Org' | 'Other';
  sourceCaptureId: string;
  confidence: number;
  /** `[source=granola|gmail|both] <snippet>` is prepended to rawContext (must_haves §provenance). */
  provenance: 'granola' | 'gmail' | 'both';
  rawContext: string;
}

export async function createInboxRow(i: CreateInboxRowInput): Promise<string> {
  const ctx = `[source=${i.provenance}] ${i.rawContext}`.slice(0, 500);
  const res = await i.client.pages.create({
    parent: { database_id: i.kosInboxId },
    properties: {
      'Proposed Entity Name': {
        title: [{ type: 'text', text: { content: i.proposedName } }],
      },
      Type: { select: { name: i.candidateType } },
      'Source Capture ID': {
        rich_text: [{ type: 'text', text: { content: i.sourceCaptureId } }],
      },
      Status: { select: { name: 'Pending' } },
      Confidence: { number: Math.round(i.confidence * 1000) / 1000 },
      'Raw Context': {
        rich_text: [{ type: 'text', text: { content: ctx } }],
      },
    },
  });
  return res.id;
}

/** Test-only helper to reset module-scope caching. */
export function __resetInboxCacheForTests(): void {
  cached = null;
}
