/**
 * Cached Notion client for kos-chat Lambda.
 * Token loaded from NOTION_TOKEN env var or Secrets Manager ARN at cold start.
 */
import { Client } from '@notionhq/client';
import { getNotionToken } from './secrets.js';

let client: Client | null = null;

export async function getNotion(): Promise<Client> {
  if (client) return client;
  const token = await getNotionToken();
  client = new Client({ auth: token });
  return client;
}

export function __setNotionForTest(fake: Client | null): void {
  client = fake;
}
