/**
 * KOS Inbox helpers for bulk-import-kontakter (Plan 02-08).
 *
 * Adapted from `services/entity-resolver/src/inbox.ts` (Plan 02-05) with two
 * minor differences:
 *   - source_capture_id is `bulk-kontakter-${yyyymmdd}` (not a per-capture ULID)
 *   - we don't need appendCaptureIdToPending (bulk import lands ONE row per
 *     unique name; if Kevin re-runs, the dedup check skips the duplicate
 *     entirely rather than appending capture IDs)
 *
 * Notion token comes from Secrets Manager via env-injected ARN (cached at
 * module scope — Pitfall 11). KOS Inbox DB ID comes from env var
 * `NOTION_KOS_INBOX_DB_ID` (CDK injects at synth time, mirrors Plan 02-05
 * pattern). Tests can supply NOTION_TOKEN + NOTION_KOS_INBOX_DB_ID directly.
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

export async function getInboxClient(): Promise<{ client: Client; kosInboxId: string }> {
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

/** Normalise a name for comparison: lowercase + trim + NFD-strip-combining-marks + collapse-spaces. */
export function normaliseName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface InboxLookup {
  approvedPageId?: string;
  pendingPageId?: string;
  /** Plan 02-08 addition: bulk import treats Merged as "already done" too. */
  mergedPageId?: string;
}

/**
 * Bulk-import-flavoured dual-read: returns the first Approved + Pending +
 * Merged hit by normalised name. Filters out Rejected — if Kevin previously
 * rejected this name, we should skip re-importing it (avoids resurrecting
 * spam contacts).
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

/**
 * Backwards-compatible alias used by the resolver naming pattern. Hidden so
 * future shared-code extraction is straightforward.
 */
export const findApprovedOrPendingInbox = findApprovedPendingOrMergedInbox;

export interface CreateInboxRowInput {
  client: Client;
  kosInboxId: string;
  proposedName: string;
  candidateType: 'Person' | 'Project' | 'Org' | 'Other';
  sourceCaptureId: string;
  confidence: number;
  rawContext: string;
}

export async function createInboxRow(i: CreateInboxRowInput): Promise<string> {
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
        rich_text: [{ type: 'text', text: { content: i.rawContext.slice(0, 500) } }],
      },
    },
  });
  return res.id;
}

/** Test-only helper to reset module-scope caching. */
export function __resetInboxCacheForTests(): void {
  cached = null;
}
