/**
 * Notion Command Center writer (voice-capture, Plan 02-04).
 *
 * The Command Center DB ID is bundled into the Lambda asset as
 * `notion-db-ids.json` at deploy time (see CDK additionalAssetFiles wiring).
 * Notion token comes from Secrets Manager via env-injected ARN; resolved on
 * first call and cached module-scope (Pitfall 11).
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

let cached: { client: Client; commandCenterId: string } | null = null;

export async function getNotion(): Promise<{ client: Client; commandCenterId: string }> {
  if (cached) return cached;

  // Resolve the bundled ids file. In Lambda, LAMBDA_TASK_ROOT points at
  // /var/task; tests can fall back to cwd.
  const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
  const idsPath = process.env.NOTION_DB_IDS_PATH ?? join(root, 'notion-db-ids.json');
  const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { commandCenter: string };
  if (!ids.commandCenter) throw new Error('commandCenter id missing from notion-db-ids.json');

  // Resolve the Notion token: prefer NOTION_TOKEN env (set in tests), else
  // fetch from Secrets Manager via NOTION_TOKEN_SECRET_ARN.
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

  cached = { client: new Client({ auth: token }), commandCenterId: ids.commandCenter };
  return cached;
}

export interface WriteCommandCenterRowInput {
  captureId: string;
  title: string;
  type: 'task' | 'meeting' | 'note' | 'question';
  urgency: 'low' | 'med' | 'high';
  body: string;
}

export async function writeCommandCenterRow(i: WriteCommandCenterRowInput): Promise<string> {
  const { client, commandCenterId } = await getNotion();
  const res = await client.pages.create({
    parent: { database_id: commandCenterId },
    properties: {
      Name: { title: [{ type: 'text', text: { content: i.title } }] },
      Type: {
        select: { name: i.type.charAt(0).toUpperCase() + i.type.slice(1) },
      },
      Urgency: { select: { name: i.urgency.toUpperCase() } },
      Status: { select: { name: 'New' } },
      'Capture ID': {
        rich_text: [{ type: 'text', text: { content: i.captureId } }],
      },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: i.body.slice(0, 2000) } }],
        },
      },
    ],
  });
  return res.id;
}

/** Test-only helper to reset the module-scope cache. */
export function __resetNotionCacheForTests(): void {
  cached = null;
}
