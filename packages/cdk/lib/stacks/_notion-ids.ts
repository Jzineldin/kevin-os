/**
 * Shared loader for `scripts/.notion-db-ids.json`. Used by both
 * `integrations-notion.ts` and `integrations-lifecycle.ts` so they don't
 * duplicate the JSON read + same required-keys validation.
 *
 * Required keys mirror the original loader in integrations-notion.ts:
 *   entities, projects, kevinContext, legacyInbox, commandCenter.
 *
 * Optional keys (synth-time empty string allowed; runtime surfaces
 * actionable error if missing on first invocation):
 *   kosInbox, todayPage, dailyBriefLog.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type NotionIds = {
  entities: string;
  projects: string;
  kevinContext: string;
  legacyInbox: string;
  commandCenter: string;
  kosInbox: string;
  todayPage: string;
  dailyBriefLog: string;
};

export function loadNotionIds(): NotionIds {
  const idFile = path.resolve(__dirname, '../../../../scripts/.notion-db-ids.json');
  const raw = fs.readFileSync(idFile, 'utf8');
  const parsed = JSON.parse(raw) as Partial<NotionIds>;
  const required: (keyof NotionIds)[] = [
    'entities',
    'projects',
    'kevinContext',
    'legacyInbox',
    'commandCenter',
  ];
  for (const k of required) {
    if (!parsed[k]) {
      throw new Error(
        `scripts/.notion-db-ids.json missing required key "${k}". ` +
          `Run scripts/bootstrap-notion-dbs.mjs first.`,
      );
    }
  }
  return {
    ...parsed,
    kosInbox: parsed.kosInbox ?? '',
    todayPage: parsed.todayPage ?? '',
    dailyBriefLog: parsed.dailyBriefLog ?? '',
  } as NotionIds;
}
