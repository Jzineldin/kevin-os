/**
 * Phase 7 Plan 07-01 — Notion writer for morning-brief.
 *
 * Two operations:
 *
 *   replaceTodayPageBlocks  → list children of 🏠 Today page → archive each
 *                              → append fresh blocks. Notion has no
 *                              transaction; on partial failure the next
 *                              brief run cleans up via archive-all-existing
 *                              before append.
 *
 *   appendDailyBriefLogPage → POST /v1/pages with parent.database_id set to
 *                              Daily Brief Log DB. One row per brief run.
 *
 * Rate limiting: Notion enforces 3 RPS per integration. We pace archives via
 * a 3-concurrent semaphore. With ≤30 children expected on 🏠 Today, that's
 * ~10 seconds worst case — well under the 10-min Lambda timeout.
 *
 * Notion token sourced from Secrets Manager (NOTION_TOKEN_SECRET_ARN env)
 * with NOTION_TOKEN as a test-only fallback (mirrors voice-capture/notion.ts).
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

  // List children — 🏠 Today should be < 100 blocks; one page is enough.
  const existing = await notion.blocks.children.list({
    block_id: todayPageId,
    page_size: 100,
  });

  // Archive each existing block at 3-concurrent pacing.
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

  // Append new blocks — single call (max 100 children per request).
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

/** Test-only helper to reset the module-scope cache. */
export function __resetNotionCacheForTests(): void {
  cached = null;
}
