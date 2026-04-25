/**
 * Phase 7 Plan 07-02 — Notion writer for weekly-review.
 *
 * Two operations:
 *
 *   appendDailyBriefLogPage      — POST /v1/pages with parent.database_id set
 *                                   to Daily Brief Log DB. One row per weekly
 *                                   review run; Type=select.weekly-review.
 *
 *   replaceActiveThreadsSection  — overwrites the "Active threads" heading_2
 *                                   section on the Kevin Context page with
 *                                   the latest snapshot. Detection is exact-
 *                                   match (case-insensitive) on the heading
 *                                   text "Active threads"; everything between
 *                                   that heading and the next heading_2 (or
 *                                   end of page) gets archived; new section
 *                                   then appended at end. T-07-WEEKLY-01
 *                                   mitigation.
 *
 *                                   If no existing section is found, falls
 *                                   back to a non-destructive append-at-end.
 *
 * Rate limiting: Notion 3 RPS — semaphore-3 paces archive PATCHes.
 *
 * Notion token sourced from Secrets Manager (NOTION_TOKEN_SECRET_ARN env)
 * with NOTION_TOKEN as a test-only fallback.
 */
import { Client } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { WeeklyReview } from '@kos/contracts';
import type { NotionBlock, DailyBriefLogPageRequest } from '../../_shared/brief-renderer.js';

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

let cached: { client: Client } | null = null;

async function getNotion(): Promise<Client> {
  if (cached) return cached.client;
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
  cached = { client: new Client({ auth: token }) };
  return cached.client;
}

/** Notion 3 RPS pacing semaphore. */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  constructor(max: number) {
    this.available = max;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export async function appendDailyBriefLogPage(
  request: DailyBriefLogPageRequest,
): Promise<{ pageId: string }> {
  const notion = await getNotion();
  const resp = await notion.pages.create(
    request as unknown as Parameters<typeof notion.pages.create>[0],
  );
  return { pageId: (resp as { id: string }).id };
}

/**
 * Walk the Kevin Context page, find the existing "Active threads" heading_2
 * section, archive everything between (inclusive) that heading and the next
 * heading_2, then append a new section at the end.
 *
 * Detection rule (T-07-WEEKLY-01 mitigation):
 *   - heading_2 plain_text starts with "active threads" (case-insensitive)
 *   - the heading itself is archived (we re-create it in the new append)
 *   - everything between that heading and the NEXT heading_2 is archived
 *   - if no existing heading found → append at end (non-destructive)
 *
 * The Notion `blocks.children.list` call paginates at 100 children per page.
 * Kevin Context is single-pager today; this implementation reads only the
 * first page. If Kevin Context grows >100 blocks, the section detection
 * still works (Notion returns blocks in order); but we'd need pagination to
 * archive the trailing tail. Documented as a Phase-9 follow-up.
 */
export async function replaceActiveThreadsSection(
  kevinContextPageId: string,
  snapshot: WeeklyReview['active_threads_snapshot'],
): Promise<void> {
  const notion = await getNotion();
  const existing = await notion.blocks.children.list({
    block_id: kevinContextPageId,
    page_size: 100,
  });

  let inSection = false;
  const toArchive: string[] = [];
  for (const b of existing.results) {
    const blk = b as {
      id: string;
      type: string;
      heading_2?: { rich_text?: Array<{ plain_text?: string }> };
    };
    if (blk.type === 'heading_2') {
      const text = (blk.heading_2?.rich_text?.[0]?.plain_text ?? '').toLowerCase();
      if (text.startsWith('active threads')) {
        inSection = true;
        toArchive.push(blk.id); // archive the heading too — recreated below
        continue;
      }
      if (inSection) {
        // Hit the next heading_2 — stop accruing.
        inSection = false;
        break;
      }
    }
    if (inSection) toArchive.push(blk.id);
  }

  if (toArchive.length > 0) {
    const sema = new Semaphore(3);
    await Promise.all(
      toArchive.map(async (id) => {
        const release = await sema.acquire();
        try {
          await notion.blocks.update({
            block_id: id,
            archived: true,
          } as unknown as Parameters<typeof notion.blocks.update>[0]);
        } finally {
          release();
        }
      }),
    );
  }

  // Build the new "Active threads" section.
  const newBlocks: NotionBlock[] = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Active threads' } }] },
    },
  ];
  for (const t of snapshot) {
    newBlocks.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          {
            type: 'text',
            text: { content: `[${t.where}] ${t.thread} — ${t.status}` },
          },
        ],
      },
    });
  }

  await notion.blocks.children.append({
    block_id: kevinContextPageId,
    children: newBlocks as unknown as Parameters<typeof notion.blocks.children.append>[0]['children'],
  });
}

/** Test-only helper to reset the module-scope cache. */
export function __resetNotionCacheForTests(): void {
  cached = null;
}
