/**
 * Notion update wrapper for the mutation-executor (Plan 08-04 task path).
 *
 * For mutation_type=='delete_task' (Notion-backed Command Center row),
 * the executor flips the Notion row's Status property to 'Arkiverad' and
 * prepends a [ARKIVERAD-<date>] migration marker to the title — same
 * audit pattern as Plan 04 [SKIPPAT-DUP].
 *
 * STRUCTURAL: this Lambda's IAM has NO Notion writes for any other DB.
 * The Notion token is scoped at the integration level to the workspace,
 * but the executor only ever touches command_center page rows.
 */
import { Client as NotionClient } from '@notionhq/client';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cached: NotionClient | null = null;
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

export async function getNotionClient(): Promise<NotionClient> {
  if (cached) return cached;
  const arn = process.env.NOTION_TOKEN_SECRET_ARN;
  if (!arn) throw new Error('NOTION_TOKEN_SECRET_ARN not set');
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error('NOTION_TOKEN_SECRET empty');
  cached = new NotionClient({ auth: r.SecretString });
  return cached;
}

export interface ArchiveCommandCenterRowInput {
  pageId: string;
  origTitle: string;
}

export async function archiveCommandCenterRow(
  client: NotionClient,
  input: ArchiveCommandCenterRowInput,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await client.pages.update({
    page_id: input.pageId,
    // The Command Center DB primary title property is 'Uppgift' per
    // services/voice-capture/src/notion.ts conventions.
    properties: {
      Uppgift: {
        title: [{ text: { content: `[ARKIVERAD-${today}] ${input.origTitle}` } }],
      },
      Status: { status: { name: 'Arkiverad' } } as never,
    },
  });
}

/** Test-only — clear cached client between vitest runs. */
export function __resetNotionForTests(): void {
  cached = null;
}
