#!/usr/bin/env node
/**
 * bootstrap-notion-dbs.mjs — idempotently provision the four Phase 1 Notion
 * databases + the Kevin Context page + Legacy Inbox DB used by the VPS freeze.
 *
 * D-11 watched DBs: Entities, Projects, Kevin Context, Command Center.
 *   - Entities / Projects / Kevin Context / Legacy Inbox are created here.
 *   - Command Center already exists in Kevin's workspace; its ID is provided
 *     via EXISTING_COMMAND_CENTER_DB_ID and persisted alongside the others
 *     (see 01-CONTEXT.md §code_context).
 *
 * Inputs:
 *   NOTION_TOKEN                  (fallback: `aws secretsmanager get-secret-value --secret-id kos/notion-token`)
 *   NOTION_PARENT_PAGE_ID         (required — Kevin's KOS parent page UUID)
 *   EXISTING_COMMAND_CENTER_DB_ID (required — Command Center DB UUID)
 *
 * Outputs:
 *   scripts/.notion-db-ids.json   (git-tracked source of truth for all five IDs)
 *
 * Idempotency: re-running never creates duplicates — each ID is verified via
 * databases.retrieve() first; only missing ones are created.
 */
import { Client } from '@notionhq/client';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_FILE = resolve(__dirname, '.notion-db-ids.json');

// --- Inputs -----------------------------------------------------------------

function getNotionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const raw = execSync(
      'aws secretsmanager get-secret-value --secret-id kos/notion-token --query SecretString --output text',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim();
    if (!raw || raw === 'null') throw new Error('secret is empty');
    return raw;
  } catch (err) {
    throw new Error(
      'NOTION_TOKEN not set and Secrets Manager fallback failed (kos/notion-token). ' +
        'Seed the secret first via scripts/seed-secrets.sh or export NOTION_TOKEN. ' +
        'Underlying error: ' +
        (err && err.message ? err.message : String(err)),
    );
  }
}

const NOTION_TOKEN = getNotionToken();
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;
if (!PARENT_PAGE_ID) {
  console.error(
    'FATAL: NOTION_PARENT_PAGE_ID is required — set it to the UUID of the Notion page that will host KOS databases.',
  );
  process.exit(2);
}

const EXISTING_COMMAND_CENTER_DB_ID = process.env.EXISTING_COMMAND_CENTER_DB_ID;
if (!EXISTING_COMMAND_CENTER_DB_ID) {
  console.error(
    'FATAL: EXISTING_COMMAND_CENTER_DB_ID is required. ' +
      'Per 01-CONTEXT.md §code_context, the Command Center DB pre-exists in ' +
      'Kevin\'s workspace and is NOT created by this bootstrap — only indexed. ' +
      'Export the existing Command Center database UUID before re-running.',
  );
  process.exit(2);
}

const notion = new Client({ auth: NOTION_TOKEN });

// --- State ------------------------------------------------------------------

/** @type {{entities?: string, projects?: string, kevinContext?: string, legacyInbox?: string, commandCenter?: string}} */
let state = {};
if (existsSync(ID_FILE)) {
  try {
    state = JSON.parse(readFileSync(ID_FILE, 'utf8'));
  } catch (err) {
    console.warn('WARN: could not parse', ID_FILE, '— starting fresh');
    state = {};
  }
}

function saveState() {
  writeFileSync(ID_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function existsDb(id) {
  if (!id) return false;
  try {
    await notion.databases.retrieve({ database_id: id });
    return true;
  } catch (err) {
    if (err && (err.code === 'object_not_found' || err.status === 404)) return false;
    throw err;
  }
}

async function existsPage(id) {
  if (!id) return false;
  try {
    await notion.pages.retrieve({ page_id: id });
    return true;
  } catch (err) {
    if (err && (err.code === 'object_not_found' || err.status === 404)) return false;
    throw err;
  }
}

// --- Property builders ------------------------------------------------------

// ENT-02 Projects schema (6 properties). LinkedPeople starts as rich_text and
// is PATCHed to a relation → Entities in pass 2 (once Entities exists).
const PROJECTS_PROPERTIES_PASS_1 = {
  "Name": { title: {} },
  "Bolag": {
    select: {
      options: [
        { name: 'Tale Forge AB' },
        { name: 'Outbehaving' },
        { name: 'Personal' },
        { name: 'Other' },
      ],
    },
  },
  "Status": {
    select: {
      options: [
        { name: 'Planning' },
        { name: 'Active' },
        { name: 'Paused' },
        { name: 'Done' },
        { name: 'Archived' },
      ],
    },
  },
  "Description": { rich_text: {} },
  // Placeholder rich_text; PATCHed to relation → Entities after Entities exists.
  "LinkedPeople": { rich_text: {} },
  "SeedContext": { rich_text: {} },
};

// ENT-01 Entities schema (13 properties). LinkedProjects relation → Projects.
function entitiesProperties(projectsDbId) {
  return {
    "Name": { title: {} },
    "Aliases": { rich_text: {} },
    "Type": {
      select: {
        options: [
          { name: 'Person' },
          { name: 'Project' },
          { name: 'Company' },
          { name: 'Document' },
        ],
      },
    },
    "Org": { rich_text: {} },
    "Role": { rich_text: {} },
    "Relationship": {
      select: {
        options: [
          { name: 'Cofounder' },
          { name: 'Advisor' },
          { name: 'Investor' },
          { name: 'Employee' },
          { name: 'Vendor' },
          { name: 'Friend' },
          { name: 'Family' },
          { name: 'Legal' },
          { name: 'Accountant' },
          { name: 'Customer' },
          { name: 'Prospect' },
          { name: 'Other' },
        ],
      },
    },
    "Status": {
      select: {
        options: [{ name: 'Active' }, { name: 'Dormant' }, { name: 'Archived' }],
      },
    },
    "LinkedProjects": {
      relation: {
        database_id: projectsDbId,
        single_property: {},
      },
    },
    "SeedContext": { rich_text: {} },
    "LastTouch": { date: {} },
    "ManualNotes": { rich_text: {} },
    "Confidence": { number: { format: 'percent' } },
    "Source": {
      multi_select: {
        options: [
          { name: 'voice' },
          { name: 'email' },
          { name: 'granola' },
          { name: 'manual' },
          { name: 'bulk-import' },
          { name: 'linkedin' },
          { name: 'whatsapp' },
        ],
      },
    },
  };
}

const LEGACY_INBOX_PROPERTIES = {
  "Name": { title: {} },
  "Source": {
    select: {
      options: [
        { name: 'classify_and_save' },
        { name: 'morning_briefing' },
        { name: 'evening_checkin' },
      ],
    },
  },
  "OriginalPayload": { rich_text: {} },
  "CreatedAt": { date: {} },
  // Holds [MIGRERAD] or [SKIPPAT-DUP] (PROJECT.md migration-marker convention)
  "Marker": { rich_text: {} },
};

const KEVIN_CONTEXT_SECTIONS = [
  'Current priorities',
  'Active deals / threads',
  "Who's who",
  'Blocked on',
  'Recent decisions',
  'Open questions',
];

// --- Creators ---------------------------------------------------------------

async function createDatabase(title, properties) {
  const resp = await notion.databases.create({
    parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
    title: [{ type: 'text', text: { content: title } }],
    properties,
  });
  return resp.id;
}

async function ensureProjectsDb() {
  if (await existsDb(state.projects)) {
    console.log('[skip] Projects DB already exists:', state.projects);
    return state.projects;
  }
  console.log('[create] Projects DB');
  state.projects = await createDatabase('KOS Projects', PROJECTS_PROPERTIES_PASS_1);
  saveState();
  return state.projects;
}

async function ensureEntitiesDb(projectsDbId) {
  if (await existsDb(state.entities)) {
    console.log('[skip] Entities DB already exists:', state.entities);
    return state.entities;
  }
  console.log('[create] Entities DB');
  state.entities = await createDatabase('KOS Entities', entitiesProperties(projectsDbId));
  saveState();
  return state.entities;
}

async function patchProjectsLinkedPeopleToRelation(projectsDbId, entitiesDbId) {
  // Read current schema; if LinkedPeople is already a relation → Entities, skip.
  const current = await notion.databases.retrieve({ database_id: projectsDbId });
  const lp = current.properties?.LinkedPeople;
  if (lp && lp.type === 'relation' && lp.relation?.database_id === entitiesDbId) {
    console.log('[skip] Projects.LinkedPeople is already a relation to Entities');
    return;
  }
  console.log('[patch] Projects.LinkedPeople → relation(Entities)');
  await notion.databases.update({
    database_id: projectsDbId,
    properties: {
      LinkedPeople: {
        relation: {
          database_id: entitiesDbId,
          single_property: {},
        },
      },
    },
  });
}

async function ensureKevinContextPage() {
  if (await existsPage(state.kevinContext)) {
    console.log('[skip] Kevin Context page already exists:', state.kevinContext);
    return state.kevinContext;
  }
  console.log('[create] Kevin Context page');
  const children = [];
  for (const heading of KEVIN_CONTEXT_SECTIONS) {
    children.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: heading } }] },
    });
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { type: 'text', text: { content: '(Seed this section with free text — Kevin edits directly.)' } },
        ],
      },
    });
  }
  const resp = await notion.pages.create({
    parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
    properties: {
      title: [{ type: 'text', text: { content: 'Kevin Context' } }],
    },
    children,
  });
  state.kevinContext = resp.id;
  saveState();
  return state.kevinContext;
}

async function ensureLegacyInboxDb() {
  if (await existsDb(state.legacyInbox)) {
    console.log('[skip] Legacy Inbox DB already exists:', state.legacyInbox);
    return state.legacyInbox;
  }
  console.log('[create] Legacy Inbox DB');
  state.legacyInbox = await createDatabase('Legacy Inbox', LEGACY_INBOX_PROPERTIES);
  saveState();
  return state.legacyInbox;
}

async function verifyAndPinCommandCenter() {
  if (!(await existsDb(EXISTING_COMMAND_CENTER_DB_ID))) {
    throw new Error(
      `EXISTING_COMMAND_CENTER_DB_ID=${EXISTING_COMMAND_CENTER_DB_ID} did not resolve via ` +
        `databases.retrieve(). Confirm the UUID and that the integration has access.`,
    );
  }
  state.commandCenter = EXISTING_COMMAND_CENTER_DB_ID;
  saveState();
  return state.commandCenter;
}

// --- Main -------------------------------------------------------------------

async function main() {
  const projectsId = await ensureProjectsDb();
  const entitiesId = await ensureEntitiesDb(projectsId);
  await patchProjectsLinkedPeopleToRelation(projectsId, entitiesId);
  const kevinContextId = await ensureKevinContextPage();
  const legacyInboxId = await ensureLegacyInboxDb();
  const commandCenterId = await verifyAndPinCommandCenter();

  console.log('');
  console.log('==== KOS Notion IDs ====');
  console.log('  entities       :', entitiesId);
  console.log('  projects       :', projectsId);
  console.log('  kevinContext   :', kevinContextId);
  console.log('  legacyInbox    :', legacyInboxId);
  console.log('  commandCenter  :', commandCenterId, '(existing)');
  console.log('');
  console.log('Persisted to:', ID_FILE);
  console.log('');
  console.log('Next: pin the Legacy Inbox DB id for the Plan 07 VPS freeze consumer:');
  console.log(
    `  aws secretsmanager create-secret --name kos/legacy-inbox-db-id --secret-string ${legacyInboxId}`,
  );
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
