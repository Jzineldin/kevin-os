/**
 * KOS Inbox Notion DB read + create + append helpers (Plan 02-05).
 *
 * Implements:
 *   - dual-read of {Approved, Pending} rows by normalised proposed name
 *     (Resolved Open Question 5)
 *   - Pitfall 7 dedup: append capture_id to existing Pending row's Source
 *     Capture ID instead of creating a duplicate Pending row
 *
 * Notion token comes from Secrets Manager via env-injected ARN; resolved on
 * first call and cached module-scope (Pitfall 11). KOS Inbox DB ID comes
 * from env var `NOTION_KOS_INBOX_DB_ID` (injected at synth time, mirrors the
 * voice-capture commandCenter pattern). Tests can fall back to NOTION_TOKEN
 * + NOTION_KOS_INBOX_DB_ID env vars directly.
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

async function getClient(): Promise<{ client: Client; kosInboxId: string }> {
  if (cached) return cached;

  // KOS Inbox DB ID — prefer env (CDK injects at synth time), then a bundled
  // notion-db-ids.json under LAMBDA_TASK_ROOT, then process.cwd() for tests.
  let kosInboxId = process.env.NOTION_KOS_INBOX_DB_ID;
  if (!kosInboxId) {
    const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
    const idsPath =
      process.env.NOTION_DB_IDS_PATH ?? join(root, 'notion-db-ids.json');
    try {
      const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { kosInbox?: string };
      if (ids.kosInbox) kosInboxId = ids.kosInbox;
    } catch {
      // fall through to error
    }
  }
  if (!kosInboxId) {
    throw new Error(
      'NOTION_KOS_INBOX_DB_ID not set and notion-db-ids.json missing kosInbox key (Plan 02-07 bootstrap must run first)',
    );
  }

  // Notion token: prefer NOTION_TOKEN env (set in tests), else fetch from
  // Secrets Manager via NOTION_TOKEN_SECRET_ARN.
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
}

/**
 * Dual-read: query KOS Inbox for rows whose Proposed Entity Name matches the
 * normalised form of `proposedName`, returning the first Approved + first
 * Pending hit (if any). Filters out Rejected; Merged rows are skipped at the
 * code-path level (we only act on Approved + Pending).
 */
export async function findApprovedOrPendingInbox(
  proposedName: string,
): Promise<InboxLookup> {
  const { client, kosInboxId } = await getClient();
  const wanted = normaliseName(proposedName);
  // Notion `title.contains` filter is the closest server-side narrowing
  // available; we re-check with our normaliseName fn client-side.
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
  }
  return out;
}

export interface CreateInboxRowInput {
  proposedName: string;
  candidateType: 'Person' | 'Project' | 'Org' | 'Other';
  candidateMatchNotionPageIds: string[];
  sourceCaptureId: string;
  confidence: number;
  rawContext: string;
}

export async function createInboxRow(i: CreateInboxRowInput): Promise<string> {
  const { client, kosInboxId } = await getClient();
  const res = await client.pages.create({
    parent: { database_id: kosInboxId },
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
      'Candidate Matches': {
        relation: i.candidateMatchNotionPageIds.map((id) => ({ id })),
      },
    },
  });
  return res.id;
}

/**
 * Append a capture_id to an existing Pending row's Source Capture ID rich_text
 * (comma-separated). Pitfall 7 mitigation: prevents duplicate Pending rows
 * across captures of the same proposed name.
 */
export async function appendCaptureIdToPending(
  pageId: string,
  captureId: string,
): Promise<void> {
  const { client } = await getClient();
  const page = (await client.pages.retrieve({ page_id: pageId })) as {
    properties: Record<string, unknown>;
  };
  const existing =
    (page.properties['Source Capture ID'] as { rich_text?: Array<{ plain_text: string }> })
      ?.rich_text?.[0]?.plain_text ?? '';
  // Avoid append-storms if the same capture_id is replayed.
  const parts = new Set(
    existing
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add(captureId);
  const merged = Array.from(parts).join(', ');
  await client.pages.update({
    page_id: pageId,
    properties: {
      'Source Capture ID': {
        rich_text: [{ type: 'text', text: { content: merged.slice(0, 2000) } }],
      },
    },
  });
}

/** Test-only helper to reset the module-scope cache. */
export function __resetInboxCacheForTests(): void {
  cached = null;
}
