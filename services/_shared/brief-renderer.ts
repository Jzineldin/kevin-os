// Phase 7 shared brief renderer — Plan 07-01 Task 1 implementation.
//
// Three pure functions consumed by all three brief Lambdas:
//
//   renderNotionTodayBlocks      — array of Notion blocks for the 🏠 Today
//                                   page (replace-in-place: archive existing,
//                                   append fresh).
//   renderDailyBriefLogPage      — single Notion page-create payload for the
//                                   Daily Brief Log database (one row per
//                                   brief run; type=morning|day-close|weekly).
//   renderTelegramHtml           — single HTML string ≤4096 chars for Telegram
//                                   sendMessage parse_mode=HTML; emitted on
//                                   kos.output / output.push.
//
// All renderers are pure (input schema → output artifact). Testable in
// isolation without Notion / Telegram clients.
//
// Design constraints honored:
//   - Notion 🏠 Today: prose-first, calm. Conditional sections. Empty arrays
//     omit their heading entirely (zero notification fatigue).
//   - Telegram: ≤ 4096 chars; truncate by priority — drop dropped_threads,
//     then secondary calendars, then prose tail; Top 3 + title NEVER drops.
//   - HTML escape on every model-supplied string (T-07-MORNING-02 mitigation).
//   - stockholmDateKey via sv-SE Intl format (matches push-telegram/quiet-hours
//     pattern; copied here so _shared has no service dependency).
import type { MorningBrief, DayCloseBrief, WeeklyReview } from '@kos/contracts';

export interface NotionBlock {
  object: 'block';
  type: string;
  [k: string]: unknown;
}

export interface DailyBriefLogPageRequest {
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children?: NotionBlock[];
}

export type BriefKind = 'morning-brief' | 'day-close' | 'weekly-review';

// ---------------------------------------------------------------------------
// Type discriminators (briefs share field names but not structure).
// ---------------------------------------------------------------------------

function isMorningBrief(b: MorningBrief | DayCloseBrief | WeeklyReview): b is MorningBrief {
  return Object.prototype.hasOwnProperty.call(b, 'calendar_today');
}
function isDayCloseBrief(b: MorningBrief | DayCloseBrief | WeeklyReview): b is DayCloseBrief {
  return Object.prototype.hasOwnProperty.call(b, 'slipped_items');
}
function isWeeklyReview(b: MorningBrief | DayCloseBrief | WeeklyReview): b is WeeklyReview {
  return Object.prototype.hasOwnProperty.call(b, 'week_recap');
}

// ---------------------------------------------------------------------------
// Notion block helpers.
// ---------------------------------------------------------------------------

function paragraph(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function heading1(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function heading2(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function bulleted(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function numbered(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

// ---------------------------------------------------------------------------
// renderNotionTodayBlocks
// ---------------------------------------------------------------------------

export function renderNotionTodayBlocks(
  brief: MorningBrief | DayCloseBrief,
  _opts: { dashUrl?: string },
): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  // Heading 1 — "Today" anchor (replace-in-place target marker).
  blocks.push(heading1('Today'));

  // Prose summary (always emit when present).
  if (brief.prose_summary && brief.prose_summary.trim()) {
    blocks.push(paragraph(brief.prose_summary));
  }

  // Top 3 — conditional. Empty array omits the entire section (calm fallback).
  if (brief.top_three && brief.top_three.length > 0) {
    blocks.push(heading2('Top 3'));
    for (const item of brief.top_three) {
      blocks.push(numbered(`${item.title} · ${item.urgency}`));
    }
  }

  // Morning-brief specific sections.
  if (isMorningBrief(brief)) {
    if (brief.calendar_today && brief.calendar_today.length > 0) {
      blocks.push(heading2('Calendar today'));
      for (const e of brief.calendar_today) {
        blocks.push(bulleted(formatCalendarEventLine(e)));
      }
    }
    if (brief.calendar_tomorrow && brief.calendar_tomorrow.length > 0) {
      blocks.push(heading2('Calendar tomorrow'));
      for (const e of brief.calendar_tomorrow) {
        blocks.push(bulleted(formatCalendarEventLine(e)));
      }
    }
    if (brief.drafts_ready && brief.drafts_ready.length > 0) {
      blocks.push(heading2('Drafts awaiting approval'));
      for (const d of brief.drafts_ready) {
        blocks.push(bulleted(`${d.classification.toUpperCase()} · ${d.from} · ${d.subject}`));
      }
    }
  }

  // Day-close specific sections.
  if (isDayCloseBrief(brief)) {
    if (brief.slipped_items && brief.slipped_items.length > 0) {
      blocks.push(heading2('Slipped items'));
      for (const s of brief.slipped_items) {
        const tail = s.reason ? ` — ${s.reason}` : '';
        blocks.push(bulleted(`${s.title}${tail}`));
      }
    }
    if (brief.recent_decisions && brief.recent_decisions.length > 0) {
      blocks.push(heading2('Recent decisions'));
      for (const d of brief.recent_decisions) {
        blocks.push(bulleted(d));
      }
    }
    if (brief.active_threads_delta && brief.active_threads_delta.length > 0) {
      blocks.push(heading2('Active threads — delta'));
      for (const t of brief.active_threads_delta) {
        blocks.push(bulleted(`${t.thread} · ${t.status}`));
      }
    }
  }

  // Common: dropped threads (morning + day-close share this).
  if (brief.dropped_threads && brief.dropped_threads.length > 0) {
    blocks.push(heading2('Dropped threads'));
    for (const dt of brief.dropped_threads) {
      blocks.push(bulleted(dt.title));
    }
  }

  return blocks;
}

function formatCalendarEventLine(e: { start: string; end?: string; title: string; attendees?: string[] }): string {
  const attendees = e.attendees && e.attendees.length > 0 ? ` · ${e.attendees.join(', ')}` : '';
  // Render the start time in Stockholm HH:mm; tolerant if start is unparseable.
  let when = '';
  try {
    const d = new Date(e.start);
    if (!Number.isNaN(d.getTime())) {
      when =
        d.toLocaleString('sv-SE', {
          timeZone: 'Europe/Stockholm',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        }) + ' · ';
    }
  } catch {
    /* ignore */
  }
  return `${when}${e.title}${attendees}`;
}

// ---------------------------------------------------------------------------
// renderDailyBriefLogPage
// ---------------------------------------------------------------------------

export function renderDailyBriefLogPage(
  brief: MorningBrief | DayCloseBrief | WeeklyReview,
  opts: { databaseId: string; dateStockholm: string; briefKind: BriefKind; dashUrl?: string },
): DailyBriefLogPageRequest {
  const titleText =
    opts.briefKind === 'morning-brief'
      ? `Morning Brief — ${opts.dateStockholm}`
      : opts.briefKind === 'day-close'
      ? `Day Close — ${opts.dateStockholm}`
      : `Weekly Review — ${opts.dateStockholm}`;

  // For weekly-review the children rendering is intentionally minimal —
  // weekly briefs don't share the morning/day-close Today shape.
  let children: NotionBlock[];
  if (isWeeklyReview(brief)) {
    children = renderWeeklyReviewBlocks(brief);
  } else {
    children = renderNotionTodayBlocks(brief, { dashUrl: opts.dashUrl });
  }

  return {
    parent: { database_id: opts.databaseId },
    properties: {
      Name: { title: [{ type: 'text', text: { content: titleText } }] },
      Date: { date: { start: opts.dateStockholm } },
      Type: { select: { name: opts.briefKind } },
    },
    children,
  };
}

function renderWeeklyReviewBlocks(brief: WeeklyReview): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  blocks.push(heading1('Week recap'));
  if (brief.prose_summary && brief.prose_summary.trim()) {
    blocks.push(paragraph(brief.prose_summary));
  }
  if (brief.week_recap && brief.week_recap.length > 0) {
    blocks.push(heading2('Highlights'));
    for (const r of brief.week_recap) {
      blocks.push(bulleted(r));
    }
  }
  if (brief.next_week_candidates && brief.next_week_candidates.length > 0) {
    blocks.push(heading2('Next week candidates'));
    for (const n of brief.next_week_candidates) {
      blocks.push(bulleted(`${n.title} — ${n.why}`));
    }
  }
  if (brief.active_threads_snapshot && brief.active_threads_snapshot.length > 0) {
    blocks.push(heading2('Active threads'));
    for (const t of brief.active_threads_snapshot) {
      blocks.push(bulleted(`${t.thread} (${t.where}) · ${t.status}`));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// renderTelegramHtml
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_CHARS = 4096;

export function renderTelegramHtml(
  brief: MorningBrief | DayCloseBrief | WeeklyReview,
  opts: { briefKind: BriefKind; dateStockholm: string; dashUrl?: string },
): string {
  // Build sections. Each section is its own string so truncateForTelegram
  // can drop them one at a time when budgeting against the 4096 limit.
  const titleLine = `<b>${escapeHtml(briefKindToLabel(opts.briefKind))}</b> · ${escapeHtml(opts.dateStockholm)}`;
  const dashAnchor = opts.dashUrl
    ? ` · <a href="${escapeHtml(opts.dashUrl)}">dashboard</a>`
    : '';
  const header = `${titleLine}${dashAnchor}`;

  const sections: { id: string; html: string }[] = [];
  sections.push({ id: 'header', html: header });

  if ('prose_summary' in brief && brief.prose_summary && brief.prose_summary.trim()) {
    sections.push({ id: 'prose', html: `<i>${escapeHtml(brief.prose_summary)}</i>` });
  }

  // Top 3 — universal across morning/day-close. Weekly review has no top_three.
  if (!isWeeklyReview(brief) && brief.top_three && brief.top_three.length > 0) {
    const lines = brief.top_three
      .map((t) => `${escapeHtml(t.title)} · <b>${escapeHtml(t.urgency)}</b>`)
      .map((l) => `• ${l}`)
      .join('\n');
    sections.push({ id: 'top3', html: `<b>Top 3</b>\n${lines}` });
  }

  if (isMorningBrief(brief)) {
    if (brief.calendar_today.length > 0) {
      const lines = brief.calendar_today
        .slice(0, 6)
        .map((e) => `• ${escapeHtml(formatCalendarEventLine(e))}`)
        .join('\n');
      sections.push({
        id: 'cal_today',
        html: `<b>Calendar today</b>\n${lines}`,
      });
    }
    if (brief.calendar_tomorrow.length > 0) {
      const lines = brief.calendar_tomorrow
        .slice(0, 6)
        .map((e) => `• ${escapeHtml(formatCalendarEventLine(e))}`)
        .join('\n');
      sections.push({
        id: 'cal_tomorrow',
        html: `<b>Calendar tomorrow</b>\n${lines}`,
      });
    }
    if (brief.drafts_ready.length > 0) {
      const lines = brief.drafts_ready
        .slice(0, 6)
        .map(
          (d) =>
            `• ${escapeHtml(d.classification.toUpperCase())} · ${escapeHtml(d.from)} · ${escapeHtml(d.subject)}`,
        )
        .join('\n');
      sections.push({ id: 'drafts', html: `<b>Drafts</b>\n${lines}` });
    }
  }

  if (isDayCloseBrief(brief)) {
    if (brief.slipped_items.length > 0) {
      const lines = brief.slipped_items
        .map((s) => `• ${escapeHtml(s.title)}${s.reason ? ` — ${escapeHtml(s.reason)}` : ''}`)
        .join('\n');
      sections.push({ id: 'slipped', html: `<b>Slipped</b>\n${lines}` });
    }
    if (brief.recent_decisions.length > 0) {
      const lines = brief.recent_decisions.map((d) => `• ${escapeHtml(d)}`).join('\n');
      sections.push({ id: 'decisions', html: `<b>Decisions</b>\n${lines}` });
    }
    if (brief.active_threads_delta.length > 0) {
      const lines = brief.active_threads_delta
        .map((t) => `• ${escapeHtml(t.thread)} · <i>${escapeHtml(t.status)}</i>`)
        .join('\n');
      sections.push({ id: 'threads_delta', html: `<b>Active threads</b>\n${lines}` });
    }
  }

  if (isWeeklyReview(brief)) {
    if (brief.week_recap.length > 0) {
      const lines = brief.week_recap.map((r) => `• ${escapeHtml(r)}`).join('\n');
      sections.push({ id: 'week_recap', html: `<b>Highlights</b>\n${lines}` });
    }
    if (brief.next_week_candidates.length > 0) {
      const lines = brief.next_week_candidates
        .map((n) => `• ${escapeHtml(n.title)} — ${escapeHtml(n.why)}`)
        .join('\n');
      sections.push({ id: 'next_week', html: `<b>Next week</b>\n${lines}` });
    }
    if (brief.active_threads_snapshot.length > 0) {
      const lines = brief.active_threads_snapshot
        .map((t) => `• ${escapeHtml(t.thread)} (${escapeHtml(t.where)}) · ${escapeHtml(t.status)}`)
        .join('\n');
      sections.push({ id: 'threads_snap', html: `<b>Active threads</b>\n${lines}` });
    }
  }

  if (
    !isWeeklyReview(brief) &&
    brief.dropped_threads &&
    brief.dropped_threads.length > 0
  ) {
    const lines = brief.dropped_threads
      .map((d) => `• ${escapeHtml(d.title)}`)
      .join('\n');
    sections.push({ id: 'dropped', html: `<b>Dropped threads</b>\n${lines}` });
  }

  // Compose with priority-ordered drop. Drop order (least essential first):
  //   1. dropped (last to add, first to drop on overflow)
  //   2. cal_tomorrow (less urgent than today)
  //   3. threads_snap / threads_delta tail
  //   4. drafts (only first item kept then drop tail)
  //   5. cal_today detail
  //   6. prose tail
  // Top 3 + header NEVER drop.
  const dropOrder = [
    'dropped',
    'cal_tomorrow',
    'threads_snap',
    'threads_delta',
    'next_week',
    'week_recap',
    'cal_today',
    'drafts',
    'slipped',
    'decisions',
    'prose',
  ];
  const composed = composeWithBudget(sections, dropOrder, TELEGRAM_MAX_CHARS);
  return truncateForTelegram(composed, TELEGRAM_MAX_CHARS);
}

function briefKindToLabel(kind: BriefKind): string {
  return kind === 'morning-brief'
    ? 'Morning Brief'
    : kind === 'day-close'
    ? 'Day Close'
    : 'Weekly Review';
}

/**
 * Greedy section composer. Joins sections with "\n\n" until total length
 * exceeds maxChars; then drops sections by id in dropOrder until it fits.
 * Header + top3 are never in dropOrder so they survive.
 */
function composeWithBudget(
  sections: { id: string; html: string }[],
  dropOrder: string[],
  maxChars: number,
): string {
  const join = (xs: { html: string }[]) => xs.map((x) => x.html).join('\n\n');
  let working = sections.slice();
  let composed = join(working);
  for (const id of dropOrder) {
    if (composed.length <= maxChars) break;
    working = working.filter((s) => s.id !== id);
    composed = join(working);
  }
  return composed;
}

// ---------------------------------------------------------------------------
// truncateForTelegram — final hard cap.
// ---------------------------------------------------------------------------

/**
 * Hard-truncate a Telegram HTML string to maxChars while attempting to land
 * on a sentence boundary. NEVER opens a new tag — if truncation would split
 * mid-tag, walks back to the previous safe character.
 *
 * NOTE: composeWithBudget upstream is responsible for SECTION-LEVEL drops
 * (priority order). truncateForTelegram is a hard guard against any residual
 * overflow (e.g. a single section longer than maxChars).
 */
export function truncateForTelegram(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  // Walk back from maxChars to the nearest period or newline; never split a tag.
  let end = maxChars;
  // Avoid splitting inside an HTML tag.
  let lt = html.lastIndexOf('<', end);
  let gt = html.lastIndexOf('>', end);
  if (lt > gt) end = lt;
  // Prefer to land on '.' or '\n' if one exists in the last 200 chars.
  const window = html.slice(Math.max(0, end - 200), end);
  const lastDot = Math.max(window.lastIndexOf('.'), window.lastIndexOf('\n'));
  if (lastDot >= 0) {
    end = end - (window.length - lastDot - 1);
  }
  return html.slice(0, Math.max(0, end));
}

// ---------------------------------------------------------------------------
// escapeHtml — minimal Telegram-safe HTML escape.
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// stockholmDateKey — duplicated from push-telegram/quiet-hours.ts so _shared
// stays self-contained.
// ---------------------------------------------------------------------------

export function stockholmDateKey(now: Date = new Date()): string {
  const sv = now.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const datePart = sv.split(' ')[0];
  if (!datePart) {
    throw new Error(`Unexpected sv-SE locale output: "${sv}"`);
  }
  return datePart;
}
