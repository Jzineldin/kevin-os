/**
 * Notion property plaintext extractors.
 *
 * T-01-04 mitigation: the indexer copies ONLY structured property values —
 * title.plain_text, select.name, rich_text.plain_text, number, date,
 * multi_select[].name. Block content (untrusted) is ignored by design.
 */

type Prop = Record<string, any> | undefined | null;

export function getTitlePlainText(prop: Prop): string {
  if (!prop) return '';
  const arr = prop.title;
  if (!Array.isArray(arr)) return '';
  return arr.map((t: any) => t?.plain_text ?? '').join('');
}

export function getRichTextPlainText(prop: Prop): string {
  if (!prop) return '';
  const arr = prop.rich_text;
  if (!Array.isArray(arr)) return '';
  return arr.map((t: any) => t?.plain_text ?? '').join('');
}

export function getSelectName(prop: Prop): string | null {
  if (!prop) return null;
  return prop.select?.name ?? null;
}

export function getMultiSelectNames(prop: Prop): string[] {
  if (!prop) return [];
  const arr = prop.multi_select;
  if (!Array.isArray(arr)) return [];
  return arr.map((s: any) => s?.name).filter((n: unknown): n is string => typeof n === 'string');
}

export function getDateISO(prop: Prop): string | null {
  if (!prop) return null;
  return prop.date?.start ?? null;
}

export function getNumber(prop: Prop): number | null {
  if (!prop) return null;
  const n = prop.number;
  return typeof n === 'number' ? n : null;
}

export function getRelationIds(prop: Prop): string[] {
  if (!prop) return [];
  const arr = prop.relation;
  if (!Array.isArray(arr)) return [];
  return arr.map((r: any) => r?.id).filter((id: unknown): id is string => typeof id === 'string');
}

/** Extract the title-like plain text from a page's top-level title property (handles both 'title' and 'Name'). */
export function getPageTitle(page: any): string {
  if (!page?.properties) return '';
  for (const key of Object.keys(page.properties)) {
    const p = page.properties[key];
    if (p?.type === 'title') return getTitlePlainText(p);
  }
  return '';
}
