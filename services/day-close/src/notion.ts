/**
 * Phase 7 Plan 07-02 — Notion writer for day-close.
 *
 * Three operations:
 *
 *   replaceTodayPageBlocks       — list children of 🏠 Today page → archive
 *                                   each → append fresh blocks. Notion has
 *                                   no transaction; on partial failure the
 *                                   next brief run cleans up via archive-
 *                                   all-existing before append.
 *
 *   appendDailyBriefLogPage      — POST /v1/pages with parent.database_id set
 *                                   to Daily Brief Log DB. One row per brief
 *                                   run; Type=select.day-close.
 *
 *   appendKevinContextSections   — Plan 07-02 Task 1 specific. Appends two
 *                                   heading_2 sections to the Kevin Context
 *                                   page: "Recent decisions (YYYY-MM-DD)" and
 *                                   "Slipped items (YYYY-MM-DD)". Does NOT
 *                                   replace existing content. Used to keep
 *                                   the Kevin Context page accreting daily
 *                                   notes Kevin can scan during morning brief.
 *
 * Rate limiting: Notion enforces 3 RPS per integration. We pace archives via
 * a 3-concurrent semaphore.
 *
 * Notion token sourced from Secrets Manager (NOTION_TOKEN_SECRET_ARN env)
 * with NOTION_TOKEN as a test-only fallback.
 */
import { Client } from '@notionhq/client';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
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

/**
 * Tiny semaphore — limits in-flight archive PATCHes to 3 (Notion 3 RPS cap).
 */
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

export async function replaceTodayPageBlocks(
  todayPageId: string,
  blocks: NotionBlock[],
): Promise<{ archivedCount: number; appendedCount: number }> {
  const notion = await getNotion();

  const existing = await notion.blocks.children.list({
    block_id: todayPageId,
    page_size: 100,
  });

  const sema = new Semaphore(3);
  await Promise.all(
    existing.results.map(async (b) => {
      const release = await sema.acquire();
      try {
        await notion.blocks.update({
          block_id: (b as { id: string }).id,
          archived: true,
        } as unknown as Parameters<typeof notion.blocks.update>[0]);
      } finally {
        release();
      }
    }),
  );

  await notion.blocks.children.append({
    block_id: todayPageId,
    children: blocks as unknown as Parameters<typeof notion.blocks.children.append>[0]['children'],
  });

  return {
    archivedCount: existing.results.length,
    appendedCount: blocks.length,
  };
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
 * Append two heading_2 sections to the Kevin Context page:
 *
 *   "Recent decisions (YYYY-MM-DD)"
 *     • <decision 1>
 *     • <decision 2>
 *     ...
 *
 *   "Slipped items (YYYY-MM-DD)"
 *     • <title> — <reason>     (or just <title> when no reason)
 *     ...
 *
 * Append-only — never archives existing Kevin Context content. Empty
 * arrays still emit the heading (user can audit "empty day" days).
 *
 * The Kevin Context page id is provided by the handler from
 * `process.env.NOTION_KEVIN_CONTEXT_PAGE_ID` — sourced from
 * `scripts/.notion-db-ids.json` via CDK env wiring.
 */
export async function appendKevinContextSections(
  kevinContextPageId: string,
  args: {
    recentDecisions: string[];
    slippedItems: { title: string; reason?: string }[];
    date: string;
  },
): Promise<void> {
  const notion = await getNotion();
  const blocks: NotionBlock[] = [];

  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: `Recent decisions (${args.date})` } }],
    },
  });
  for (const d of args.recentDecisions) {
    blocks.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: d } }],
      },
    });
  }

  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: `Slipped items (${args.date})` } }],
    },
  });
  for (const i of args.slippedItems) {
    const text = i.reason ? `${i.title} — ${i.reason}` : i.title;
    blocks.push({
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: text } }],
      },
    });
  }

  await notion.blocks.children.append({
    block_id: kevinContextPageId,
    children: blocks as unknown as Parameters<typeof notion.blocks.children.append>[0]['children'],
  });
}

/** Test-only helper to reset the module-scope cache. */
export function __resetNotionCacheForTests(): void {
  cached = null;
}
