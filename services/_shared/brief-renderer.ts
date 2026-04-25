// Phase 7 shared brief renderer — Plan 07-00 scaffold. Real bodies land in
// Plan 07-01 Task 1 (morning-brief renderer + Notion replace-in-place blocks)
// and 07-02 (day-close + weekly-review variants).
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

export function renderNotionTodayBlocks(
  _brief: MorningBrief | DayCloseBrief,
  _opts: { dashUrl?: string },
): NotionBlock[] {
  throw new Error('Not implemented yet — Plan 07-01 Task 1');
}

export function renderDailyBriefLogPage(
  _brief: MorningBrief | DayCloseBrief | WeeklyReview,
  _opts: { databaseId: string; dateStockholm: string; briefKind: BriefKind },
): DailyBriefLogPageRequest {
  throw new Error('Not implemented yet — Plan 07-01 Task 1');
}

export function renderTelegramHtml(
  _brief: MorningBrief | DayCloseBrief | WeeklyReview,
  _opts: { briefKind: BriefKind; dateStockholm: string; dashUrl?: string },
): string {
  throw new Error('Not implemented yet — Plan 07-01 Task 1');
}
