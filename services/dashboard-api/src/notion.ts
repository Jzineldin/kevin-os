/**
 * Cached Notion client — one per warm Lambda instance.
 *
 * Token is sourced from the NOTION_TOKEN env var (P-04 env-var approach —
 * Plan 05 CDK injects it from Secrets Manager at deploy time so the VPC
 * Lambda never needs a Secrets Manager VPC endpoint at runtime).
 */
import { Client } from '@notionhq/client';

let client: Client | null = null;

export function getNotion(): Client {
  if (client) return client;
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error('[dashboard-api] NOTION_TOKEN env var is required');
  }
  client = new Client({ auth: token });
  return client;
}

/** Test seam — let Vitest inject a fake Notion client. Production never calls. */
export function __setNotionForTest(fake: Client | null): void {
  client = fake;
}
