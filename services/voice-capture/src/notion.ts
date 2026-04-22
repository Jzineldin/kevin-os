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

  // Prefer env-injected ID (CDK route — see KosAgents env vars). Fall back
  // to the bundled file for local tests. The file path was the original
  // plan but the bundling didn't get wired, so env-first is required for
  // production.
  let commandCenterId = process.env.NOTION_COMMAND_CENTER_DB_ID ?? '';
  if (!commandCenterId) {
    const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
    const idsPath = process.env.NOTION_DB_IDS_PATH ?? join(root, 'notion-db-ids.json');
    const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { commandCenter: string };
    commandCenterId = ids.commandCenter;
  }
  if (!commandCenterId) {
    throw new Error('NOTION_COMMAND_CENTER_DB_ID env not set and no notion-db-ids.json bundled');
  }
  const ids = { commandCenter: commandCenterId };

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

// Map Phase 2 internal vocab → Kevin's existing Swedish Command Center
// schema (live-discovered 2026-04-22 — DB has Uppgift/Typ/Prioritet not
// Name/Type/Urgency, and select options are Swedish + emoji-prefixed).
const TYP_MAP: Record<string, string> = {
  task: 'Task',
  note: 'Notering',
  // 'meeting' / 'question' have no native option; fall back to 'Notering'.
  meeting: 'Notering',
  question: 'Notering',
};
const PRIORITET_MAP: Record<string, string> = {
  high: '🔴 Hög',
  med: '🟡 Medel',
  low: '🟢 Låg',
};

export async function writeCommandCenterRow(i: WriteCommandCenterRowInput): Promise<string> {
  const { client, commandCenterId } = await getNotion();
  const res = await client.pages.create({
    parent: { database_id: commandCenterId },
    properties: {
      Uppgift: { title: [{ type: 'text', text: { content: i.title } }] },
      Typ: { select: { name: TYP_MAP[i.type] ?? 'Notering' } },
      Prioritet: { select: { name: PRIORITET_MAP[i.urgency] ?? '🟡 Medel' } },
      Status: { select: { name: '📥 Inbox' } },
      Anteckningar: {
        rich_text: [
          {
            type: 'text',
            text: { content: `${i.body}\n\n— capture_id: ${i.captureId}` },
          },
        ],
      },
    },
  });
  return res.id;
}

/** Test-only helper to reset the module-scope cache. */
export function __resetNotionCacheForTests(): void {
  cached = null;
}
