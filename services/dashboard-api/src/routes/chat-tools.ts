/**
 * Phase 11 Plan 11-04 — tool implementations for the /chat agent.
 *
 * Kevin's Command Center in Notion uses Swedish schema:
 *   - Uppgift (title)
 *   - Prioritet (select: 🔴 Hög / 🟡 Medel / 🟢 Låg)
 *   - Status (select: 📥 Inbox / 🔥 Idag / 🔨 Pågår / ✅ Klart / ⏳ Väntar / ❌ Skippat)
 *   - Bolag (select: Tale Forge / Outbehaving / Personal / Other)
 *
 * The agent receives these tools and can invoke them when Kevin
 * conversationally asks for mutations (e.g. "deprioritize X",
 * "mark Y as done"). Every mutation writes an event_log row tagged
 * 'kos-chat:mutation' so Kevin has a full audit trail.
 *
 * Safety model (D-17 + KOS-overview anti-feature):
 *   - INTERNAL state (Command Center, entity_index) auto-applies.
 *     Kevin explicitly asked in-chat; re-asking for Approve would
 *     defeat the conversational UX.
 *   - EXTERNAL state (SES send, Postiz publish) is NOT exposed as a
 *     tool to this agent — those remain Approve-gated via /inbox.
 */
import { sql } from 'drizzle-orm';
import { getNotion } from '../notion.js';
import { getDb } from '../db.js';
import { OWNER_ID } from '../owner-scoped.js';

export type PriorityLabel = '🔴 Hög' | '🟡 Medel' | '🟢 Låg';
export type StatusLabel =
  | '📥 Inbox'
  | '🔥 Idag'
  | '🔨 Pågår'
  | '✅ Klart'
  | '⏳ Väntar'
  | '❌ Skippat';
export type BolagLabel = 'Tale Forge' | 'Outbehaving' | 'Personal' | 'Other';

const PRIORITY_NORMALIZE: Record<string, PriorityLabel> = {
  hög: '🔴 Hög',
  hog: '🔴 Hög',
  high: '🔴 Hög',
  h: '🔴 Hög',
  '🔴 hög': '🔴 Hög',
  medel: '🟡 Medel',
  med: '🟡 Medel',
  medium: '🟡 Medel',
  m: '🟡 Medel',
  '🟡 medel': '🟡 Medel',
  låg: '🟢 Låg',
  lag: '🟢 Låg',
  low: '🟢 Låg',
  l: '🟢 Låg',
  '🟢 låg': '🟢 Låg',
};

const STATUS_NORMALIZE: Record<string, StatusLabel> = {
  inbox: '📥 Inbox',
  'in box': '📥 Inbox',
  idag: '🔥 Idag',
  today: '🔥 Idag',
  pågår: '🔨 Pågår',
  pagar: '🔨 Pågår',
  'in progress': '🔨 Pågår',
  ongoing: '🔨 Pågår',
  klar: '✅ Klart',
  klart: '✅ Klart',
  done: '✅ Klart',
  complete: '✅ Klart',
  completed: '✅ Klart',
  väntar: '⏳ Väntar',
  vantar: '⏳ Väntar',
  waiting: '⏳ Väntar',
  pending: '⏳ Väntar',
  skippat: '❌ Skippat',
  skipped: '❌ Skippat',
  dropped: '❌ Skippat',
};

function normalizePriority(input: string): PriorityLabel | null {
  const key = input.trim().toLowerCase();
  return PRIORITY_NORMALIZE[key] ?? null;
}
function normalizeStatus(input: string): StatusLabel | null {
  const key = input.trim().toLowerCase();
  return STATUS_NORMALIZE[key] ?? null;
}

interface CommandCenterPage {
  id: string;
  title: string;
  prioritet: string | null;
  status: string | null;
  bolag: string | null;
}

async function listOpenTasks(): Promise<CommandCenterPage[]> {
  const cmdCenterDb = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!cmdCenterDb) return [];
  const res = await getNotion().databases.query({
    database_id: cmdCenterDb,
    filter: {
      and: [
        { property: 'Status', select: { does_not_equal: '✅ Klart' } },
        { property: 'Status', select: { does_not_equal: '❌ Skippat' } },
      ],
    },
    page_size: 100,
  });
  return (res.results as Array<{ id: string; properties: Record<string, unknown> }>).map((p) => {
    const props = p.properties;
    const titleProp = props['Uppgift'] as
      | { title?: Array<{ plain_text?: string }> }
      | undefined;
    const prio = (props['Prioritet'] as { select?: { name?: string } } | undefined)?.select?.name ?? null;
    const status = (props['Status'] as { select?: { name?: string } } | undefined)?.select?.name ?? null;
    const bolag = (props['Bolag'] as { select?: { name?: string } } | undefined)?.select?.name ?? null;
    const title = (titleProp?.title ?? [])
      .map((t) => t.plain_text ?? '')
      .join('')
      .trim();
    return { id: p.id, title, prioritet: prio, status, bolag };
  });
}

/**
 * Fuzzy-match a query against open Command Center task titles.
 * Returns the best match (case-insensitive substring or token overlap)
 * OR null if nothing plausibly matches. When the agent calls a mutation
 * tool with a fuzzy query, we refuse cleanly rather than guess.
 */
function findBestMatch(
  query: string,
  tasks: CommandCenterPage[],
): CommandCenterPage | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  // 1. Exact substring
  const sub = tasks.find((t) => t.title.toLowerCase().includes(q));
  if (sub) return sub;
  // 2. Token overlap — >=50% of query tokens appear in title
  const qTokens = q.split(/\s+/).filter((t) => t.length > 2);
  if (qTokens.length === 0) return null;
  let best: { task: CommandCenterPage; score: number } | null = null;
  for (const t of tasks) {
    const title = t.title.toLowerCase();
    const hits = qTokens.filter((tok) => title.includes(tok)).length;
    const score = hits / qTokens.length;
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { task: t, score };
    }
  }
  return best?.task ?? null;
}

async function logMutation(
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  // Best-effort audit — if dashboard_api doesn't have INSERT on event_log
  // (or any other DB-side issue), we DON'T want the tool call to appear to
  // have failed. The Notion mutation already succeeded at this point.
  try {
    const db = await getDb();
    await db.execute(sql`
      INSERT INTO event_log (owner_id, kind, actor, occurred_at, detail)
      VALUES (${OWNER_ID}, ${kind}, 'kos-chat', now(), ${JSON.stringify(detail)}::jsonb)
    `);
  } catch (err) {
    console.warn('[chat-tools] event_log audit failed (non-fatal):', err);
  }
}

// --- Tool: search_entities --------------------------------------------------

export interface SearchEntitiesArgs {
  query: string;
  limit?: number;
}

export async function toolSearchEntities(args: SearchEntitiesArgs): Promise<{
  results: Array<{
    id: string;
    name: string;
    type: string;
    relationship: string | null;
    last_touch: string | null;
  }>;
}> {
  const db = await getDb();
  const limit = Math.max(1, Math.min(20, args.limit ?? 10));
  const q = `%${args.query.toLowerCase()}%`;
  const r = (await db.execute(sql`
    SELECT id::text AS id, name, type, relationship, last_touch::text AS last_touch
    FROM entity_index
    WHERE owner_id = ${OWNER_ID}
      AND lower(name) LIKE ${q}
    ORDER BY last_touch DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as {
    rows: Array<{
      id: string;
      name: string;
      type: string;
      relationship: string | null;
      last_touch: string | null;
    }>;
  };
  return { results: r.rows };
}

// --- Tool: list_open_tasks --------------------------------------------------

export async function toolListOpenTasks(): Promise<{
  tasks: Array<{
    id: string;
    title: string;
    prioritet: string | null;
    status: string | null;
    bolag: string | null;
  }>;
}> {
  const tasks = await listOpenTasks();
  // Return the 20 most relevant for the agent's context — it can narrow
  // further by calling update_task_priority with a title query.
  return {
    tasks: tasks.slice(0, 20).map((t) => ({
      id: t.id,
      title: t.title,
      prioritet: t.prioritet,
      status: t.status,
      bolag: t.bolag,
    })),
  };
}

// --- Tool: update_task_priority --------------------------------------------

export interface UpdateTaskPriorityArgs {
  task_title_query: string;
  new_priority: string;
}

export async function toolUpdateTaskPriority(
  args: UpdateTaskPriorityArgs,
): Promise<{
  ok: boolean;
  matched?: { id: string; title: string };
  from?: string | null;
  to?: PriorityLabel;
  error?: string;
}> {
  const prio = normalizePriority(args.new_priority);
  if (!prio) {
    return {
      ok: false,
      error: `Unknown priority '${args.new_priority}'. Valid: Hög, Medel, Låg (or high/medium/low).`,
    };
  }
  const tasks = await listOpenTasks();
  const match = findBestMatch(args.task_title_query, tasks);
  if (!match) {
    return {
      ok: false,
      error: `No open task matched '${args.task_title_query}'. Call list_open_tasks to see what's available.`,
    };
  }
  const from = match.prioritet;
  await getNotion().pages.update({
    page_id: match.id,
    properties: {
      Prioritet: { select: { name: prio } },
    },
  });
  await logMutation('kos-chat:priority-updated', {
    page_id: match.id,
    title: match.title,
    from,
    to: prio,
    query: args.task_title_query,
  });
  return {
    ok: true,
    matched: { id: match.id, title: match.title },
    from,
    to: prio,
  };
}

// --- Tool: update_task_status ----------------------------------------------

export interface UpdateTaskStatusArgs {
  task_title_query: string;
  new_status: string;
}

export async function toolUpdateTaskStatus(
  args: UpdateTaskStatusArgs,
): Promise<{
  ok: boolean;
  matched?: { id: string; title: string };
  from?: string | null;
  to?: StatusLabel;
  error?: string;
}> {
  const status = normalizeStatus(args.new_status);
  if (!status) {
    return {
      ok: false,
      error: `Unknown status '${args.new_status}'. Valid: Inbox, Idag, Pågår, Klart, Väntar, Skippat (or today/done/waiting/skipped).`,
    };
  }
  const tasks = await listOpenTasks();
  const match = findBestMatch(args.task_title_query, tasks);
  if (!match) {
    return {
      ok: false,
      error: `No open task matched '${args.task_title_query}'. Call list_open_tasks to see what's available.`,
    };
  }
  const from = match.status;
  await getNotion().pages.update({
    page_id: match.id,
    properties: {
      Status: { select: { name: status } },
    },
  });
  await logMutation('kos-chat:status-updated', {
    page_id: match.id,
    title: match.title,
    from,
    to: status,
    query: args.task_title_query,
  });
  return {
    ok: true,
    matched: { id: match.id, title: match.title },
    from,
    to: status,
  };
}

// --- Tool: add_task --------------------------------------------------------

export interface AddTaskArgs {
  title: string;
  priority?: string;
  status?: string;
  bolag?: string;
}

export async function toolAddTask(args: AddTaskArgs): Promise<{
  ok: boolean;
  page_id?: string;
  title?: string;
  error?: string;
}> {
  const cmdCenterDb = process.env.NOTION_COMMAND_CENTER_DB_ID;
  if (!cmdCenterDb) {
    return { ok: false, error: 'NOTION_COMMAND_CENTER_DB_ID not set' };
  }
  const title = args.title.trim();
  if (!title) return { ok: false, error: 'title cannot be empty' };
  const properties: Record<string, unknown> = {
    Uppgift: { title: [{ text: { content: title.slice(0, 200) } }] },
  };
  if (args.priority) {
    const p = normalizePriority(args.priority);
    if (p) properties['Prioritet'] = { select: { name: p } };
  }
  if (args.status) {
    const s = normalizeStatus(args.status);
    if (s) properties['Status'] = { select: { name: s } };
  } else {
    properties['Status'] = { select: { name: '📥 Inbox' } };
  }
  if (args.bolag) {
    const bolag = args.bolag.trim();
    // Kevin's Bolag select values are the exact strings — don't munge.
    if (['Tale Forge', 'Outbehaving', 'Personal', 'Other'].includes(bolag)) {
      properties['Bolag'] = { select: { name: bolag } };
    }
  }
  const page = (await getNotion().pages.create({
    parent: { database_id: cmdCenterDb },
    properties,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as { id: string };
  await logMutation('kos-chat:task-created', {
    page_id: page.id,
    title,
    priority: args.priority ?? null,
    status: args.status ?? null,
    bolag: args.bolag ?? null,
  });
  return { ok: true, page_id: page.id, title };
}

// --- Tool schemas for Bedrock ---------------------------------------------

export const TOOL_DEFS = [
  {
    name: 'list_open_tasks',
    description:
      "List the up to 20 open (not Klart or Skippat) Command Center tasks with their current Prioritet + Status + Bolag. Call this BEFORE update_task_priority or update_task_status if you're unsure which task Kevin means.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_task_priority',
    description:
      "Change the Prioritet (priority) of one open Command Center task. Fuzzy-matches task_title_query against open task titles. new_priority accepts Hög|Medel|Låg or high|medium|low. Auto-applies (no further approval needed — Kevin explicitly asked in chat).",
    input_schema: {
      type: 'object',
      properties: {
        task_title_query: {
          type: 'string',
          description:
            'A substring or fuzzy description of the task title. Example: "email-forwarding" matches "Sätt upp email-forwarding tale-forge.app → Gmail".',
        },
        new_priority: {
          type: 'string',
          description: 'Hög | Medel | Låg (Swedish) or high | medium | low',
        },
      },
      required: ['task_title_query', 'new_priority'],
    },
  },
  {
    name: 'update_task_status',
    description:
      "Change the Status of one open Command Center task. Valid statuses: Inbox, Idag, Pågår, Klart, Väntar, Skippat (or english equivalents). Use this to mark a task as done ('Klart') or move it to today's focus ('Idag').",
    input_schema: {
      type: 'object',
      properties: {
        task_title_query: { type: 'string' },
        new_status: {
          type: 'string',
          description:
            'Inbox | Idag | Pågår | Klart | Väntar | Skippat (or english: today, in progress, done, waiting, skipped)',
        },
      },
      required: ['task_title_query', 'new_status'],
    },
  },
  {
    name: 'add_task',
    description:
      "Create a new task in Kevin's Command Center. Use when Kevin asks to add something he wants to track. Defaults: Status=Inbox if not specified.",
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Task title in the language Kevin used. Max 200 chars.',
        },
        priority: { type: 'string', description: 'Optional. Hög|Medel|Låg' },
        status: { type: 'string', description: 'Optional. Inbox|Idag|Pågår|Väntar (default Inbox).' },
        bolag: {
          type: 'string',
          description: 'Optional. Tale Forge | Outbehaving | Personal | Other',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'search_entities',
    description:
      "Fuzzy-search Kevin's entity_index by name. Returns matching people/organizations/projects with their relationship + last_touch. Use when the user's message references someone by partial name and you need to confirm identity before answering.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match (case-insensitive).' },
        limit: { type: 'number', description: 'Default 10, max 20.' },
      },
      required: ['query'],
    },
  },
];

export type ToolName =
  | 'list_open_tasks'
  | 'update_task_priority'
  | 'update_task_status'
  | 'add_task'
  | 'search_entities';

export async function dispatchTool(name: string, input: unknown): Promise<unknown> {
  try {
    switch (name as ToolName) {
      case 'list_open_tasks':
        return await toolListOpenTasks();
      case 'update_task_priority':
        return await toolUpdateTaskPriority(input as UpdateTaskPriorityArgs);
      case 'update_task_status':
        return await toolUpdateTaskStatus(input as UpdateTaskStatusArgs);
      case 'add_task':
        return await toolAddTask(input as AddTaskArgs);
      case 'search_entities':
        return await toolSearchEntities(input as SearchEntitiesArgs);
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error).message ?? err).slice(0, 400),
    };
  }
}
