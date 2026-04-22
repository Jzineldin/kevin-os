/**
 * Kontakter Notion DB reader (Plan 02-08, ENT-05).
 *
 * Three responsibilities:
 *   1. discoverKontakterDbId — first-run resolution of Kevin's Kontakter DB
 *      via `notion.search`. Persisted to scripts/.notion-db-ids.json by the
 *      operator after the first successful invocation.
 *   2. readKontakter — async-generator-style cursor-paginated reader; yields
 *      one row at a time so the handler can dedup + write incrementally.
 *   3. mapKontakterToInboxInput — flexible field mapper that tolerates the
 *      property-name drift Kevin's Kontakter DB might exhibit (Name vs Namn,
 *      Org vs Company vs Bolag, etc.). Logs `console.warn` per missing field
 *      so the operator sees the drift on first import.
 *
 * Field mapping strategy (T-02-BULK-04 mitigation): each logical property
 * (name/org/role/email/phone/notes) is resolved by trying a list of likely
 * Notion property names in order and returning the first non-empty match.
 * The "Name" title property is special-cased — Notion guarantees exactly one
 * `type: 'title'` property per database, so we walk properties to find it
 * regardless of label.
 */

import type { Client } from '@notionhq/client';

export interface KontakterRow {
  id: string;
  name: string;
  org: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  /** Original Notion last_edited_time, useful for downstream audit. */
  lastEditedTime: string;
}

/**
 * Resolve Kevin's Kontakter Notion database UUID by name search.
 *
 * Throws an actionable error on 0 or >1 hits — operator must either rename
 * their DB or set `KONTAKTER_DB_ID` explicitly in the Lambda env via
 * `aws lambda update-function-configuration`.
 */
export async function discoverKontakterDbId(notion: Client): Promise<string> {
  const res = await notion.search({
    query: 'Kontakter',
    filter: { property: 'object', value: 'database' },
    page_size: 25,
  });
  const dbs = ((res.results ?? []) as any[]).filter(
    (r) => r?.object === 'database',
  );
  // Narrow further: exact-title match (case-insensitive) — guards against
  // Kevin having other DBs that mention "Kontakter" in the title.
  const exact = dbs.filter((d: any) => {
    const titleArr: Array<{ plain_text?: string }> = Array.isArray(d.title) ? d.title : [];
    const title = titleArr
      .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
      .join('')
      .trim()
      .toLowerCase();
    return title === 'kontakter';
  });
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length === 0) {
    throw new Error(
      'discoverKontakterDbId: no database titled exactly "Kontakter" found. ' +
        'Set KONTAKTER_DB_ID in Lambda env explicitly via ' +
        '`aws lambda update-function-configuration --function-name KosAgents-BulkImportKontakter --environment Variables={KONTAKTER_DB_ID=<uuid>}` ' +
        'or persist it to scripts/.notion-db-ids.json under key "kontakter".',
    );
  }
  // exact.length > 1
  throw new Error(
    `discoverKontakterDbId: ${exact.length} databases titled "Kontakter" found (ambiguous). ` +
      'Set KONTAKTER_DB_ID in Lambda env explicitly to the correct UUID. ' +
      `Candidates: ${exact.map((d) => d.id).join(', ')}`,
  );
}

/**
 * Cursor-paginated read of every Kontakter row. Yields one row at a time so
 * the handler can interleave dedup checks + Notion writes without buffering
 * the whole DB in memory.
 */
export async function* readKontakter(
  notion: Client,
  dbId: string,
): AsyncGenerator<KontakterRow> {
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({
      database_id: dbId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of (res.results ?? []) as any[]) {
      const mapped = readRow(page);
      if (mapped) yield mapped;
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
}

/**
 * Read one Notion page row → KontakterRow. Returns null only if no usable
 * Name field can be extracted (the row is unimportable without a name).
 */
function readRow(page: any): KontakterRow | null {
  const props = page?.properties ?? {};
  const name = extractTitle(props);
  if (!name) {
    console.warn(`[bulk-kontakter] row ${page?.id} has no usable title; skipping`);
    return null;
  }
  return {
    id: String(page.id),
    name,
    org: pickRichTextOrSelect(props, ['Org', 'Company', 'Bolag', 'Företag', 'Organization']),
    role: pickRichTextOrSelect(props, ['Role', 'Roll', 'Title', 'Titel', 'Position']),
    email: pickEmail(props, ['Email', 'E-post', 'Mail']),
    phone: pickPhone(props, ['Phone', 'Telefon', 'Mobile', 'Mobil']),
    notes: pickRichTextOrSelect(props, ['Notes', 'Anteckningar', 'Description', 'Beskrivning']),
    lastEditedTime: String(page.last_edited_time ?? ''),
  };
}

function extractTitle(props: Record<string, any>): string | null {
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === 'title' && Array.isArray(p.title)) {
      const txt = p.title
        .map((t: any) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
        .join('')
        .trim();
      if (txt) return txt;
    }
  }
  return null;
}

function pickRichTextOrSelect(props: Record<string, any>, candidates: string[]): string | null {
  for (const key of candidates) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'rich_text' && Array.isArray(p.rich_text)) {
      const txt = p.rich_text
        .map((t: any) => (typeof t?.plain_text === 'string' ? t.plain_text : ''))
        .join('')
        .trim();
      if (txt) return txt;
    }
    if (p.type === 'select' && p.select?.name) return String(p.select.name);
    if (p.type === 'multi_select' && Array.isArray(p.multi_select) && p.multi_select.length > 0) {
      return p.multi_select.map((s: any) => s?.name).filter(Boolean).join(', ');
    }
  }
  // No hit — log warn ONCE per logical field would be ideal but at module
  // scope it's noisy; instead stay quiet and let caller warn at row level.
  return null;
}

function pickEmail(props: Record<string, any>, candidates: string[]): string | null {
  for (const key of candidates) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'email' && typeof p.email === 'string' && p.email) return p.email;
    if (p.type === 'rich_text' && Array.isArray(p.rich_text)) {
      const txt = p.rich_text.map((t: any) => t?.plain_text ?? '').join('').trim();
      if (txt) return txt;
    }
  }
  return null;
}

function pickPhone(props: Record<string, any>, candidates: string[]): string | null {
  for (const key of candidates) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'phone_number' && typeof p.phone_number === 'string' && p.phone_number) {
      return p.phone_number;
    }
    if (p.type === 'rich_text' && Array.isArray(p.rich_text)) {
      const txt = p.rich_text.map((t: any) => t?.plain_text ?? '').join('').trim();
      if (txt) return txt;
    }
  }
  return null;
}

export interface InboxInput {
  proposedName: string;
  candidateType: 'Person';
  seedContext: string;
  rawContext: string;
}

/**
 * Build a KOS Inbox row payload from a Kontakter row. Everything is
 * defensive: missing fields produce an "n/a" placeholder so Kevin can still
 * see the partial dossier and decide whether to fix in Notion before
 * approving.
 *
 * SeedContext format: `${role} @ ${org}. Email: ${email}. Notes: ${notes}` —
 * trimmed to 500 chars so it fits in the KOS Inbox `Raw Context` rich_text
 * cap (D-13).
 */
export function mapKontakterToInboxInput(row: KontakterRow): InboxInput {
  const missing: string[] = [];
  if (!row.org) missing.push('org');
  if (!row.role) missing.push('role');
  if (!row.email) missing.push('email');
  if (missing.length > 0) {
    console.warn(
      `[bulk-kontakter] row ${row.id} (${row.name}) missing fields: ${missing.join(', ')}`,
    );
  }
  const role = row.role ?? 'unknown role';
  const org = row.org ?? 'unknown org';
  const email = row.email ?? 'n/a';
  const phone = row.phone ?? 'n/a';
  const notes = row.notes ?? '';
  const seedContext = `${role} @ ${org}. Email: ${email}. Phone: ${phone}. Notes: ${notes}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return {
    proposedName: row.name,
    candidateType: 'Person',
    seedContext,
    rawContext: seedContext,
  };
}
