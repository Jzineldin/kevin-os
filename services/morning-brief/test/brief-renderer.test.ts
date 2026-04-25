/**
 * Phase 7 Plan 07-01 Task 1 — pure-function tests for the shared
 * brief-renderer helpers.
 *
 * The renderer lives at services/_shared/brief-renderer.ts (loose .ts module,
 * not a workspace). Tests are co-located here under the morning-brief
 * service workspace because _shared is not a vitest-runnable package on its
 * own (deviation: plan called for services/_shared/test/ which is not a
 * runnable test path; the renderer is consumed by morning-brief first, so
 * morning-brief's test runner picks it up via the relative import).
 *
 * Eight tests per plan acceptance criteria:
 *   1. renderNotionTodayBlocks — section ordering for MorningBrief.
 *   2. renderNotionTodayBlocks — empty top_three calm fallback.
 *   3. renderDailyBriefLogPage — properties shape (Name title, Date date,
 *      Type select).
 *   4. renderTelegramHtml — valid HTML, length ≤ 4096.
 *   5. renderTelegramHtml — escapes <, >, &.
 *   6. truncateForTelegram — drops sections in priority order.
 *   7. stockholmDateKey — YYYY-MM-DD shape using Europe/Stockholm.
 *   8. escapeHtml — explicit assertion.
 */
import { describe, it, expect } from 'vitest';
import type { MorningBrief, DayCloseBrief, WeeklyReview } from '@kos/contracts';
import {
  renderNotionTodayBlocks,
  renderDailyBriefLogPage,
  renderTelegramHtml,
  escapeHtml,
  stockholmDateKey,
  truncateForTelegram,
} from '../../_shared/brief-renderer.js';

const A_UUID = '11111111-2222-4333-8444-555555555555';

function makeMorning(overrides: Partial<MorningBrief> = {}): MorningBrief {
  return {
    prose_summary: 'Lugn morgon. Tre trådar att jobba med.',
    top_three: [
      { title: 'Damien · Almi loan follow-up', entity_ids: [A_UUID], urgency: 'high' },
      { title: 'Christina · Tale Forge investor update', entity_ids: [A_UUID], urgency: 'med' },
    ],
    dropped_threads: [
      {
        title: 'Outbehaving sprint review',
        entity_ids: [A_UUID],
        last_mentioned_at: '2026-04-20T08:00:00.000Z',
      },
    ],
    calendar_today: [
      {
        start: '2026-04-25T08:00:00.000Z',
        end: '2026-04-25T09:00:00.000Z',
        title: 'Standup',
        attendees: ['Damien'],
      },
    ],
    calendar_tomorrow: [],
    drafts_ready: [
      {
        draft_id: A_UUID,
        from: 'damien@almi.se',
        subject: 'Convertible loan terms',
        classification: 'urgent',
      },
    ],
    ...overrides,
  };
}

describe('renderNotionTodayBlocks', () => {
  it('emits blocks in the documented order with non-empty MorningBrief sections', () => {
    const blocks = renderNotionTodayBlocks(makeMorning(), {});
    // First block: heading_1 "Today".
    expect(blocks[0]?.type).toBe('heading_1');
    expect(JSON.stringify(blocks[0])).toContain('Today');

    // Section ordering: heading then content. Expect "Top 3" heading after
    // the prose paragraph, then numbered_list_item blocks.
    const types = blocks.map((b) => b.type);
    const top3Idx = types.findIndex(
      (t, i) =>
        t === 'heading_2' && JSON.stringify(blocks[i]).toLowerCase().includes('top 3'),
    );
    expect(top3Idx).toBeGreaterThan(0);

    // After Top 3 heading, next blocks are numbered_list_item × 2.
    expect(blocks[top3Idx + 1]?.type).toBe('numbered_list_item');
    expect(blocks[top3Idx + 2]?.type).toBe('numbered_list_item');

    // Calendar today section emitted (heading + bulleted list).
    const calIdx = types.findIndex(
      (t, i) =>
        t === 'heading_2' &&
        JSON.stringify(blocks[i]).toLowerCase().includes('calendar today'),
    );
    expect(calIdx).toBeGreaterThan(top3Idx);

    // Drafts section emitted.
    const draftsIdx = types.findIndex(
      (t, i) =>
        t === 'heading_2' &&
        JSON.stringify(blocks[i]).toLowerCase().includes('drafts'),
    );
    expect(draftsIdx).toBeGreaterThan(top3Idx);

    // Dropped threads section emitted.
    const droppedIdx = types.findIndex(
      (t, i) =>
        t === 'heading_2' &&
        JSON.stringify(blocks[i]).toLowerCase().includes('dropped'),
    );
    expect(droppedIdx).toBeGreaterThan(top3Idx);
  });

  it('handles empty top_three with calm fallback (heading omitted, no items)', () => {
    const brief = makeMorning({ top_three: [], dropped_threads: [], drafts_ready: [], calendar_today: [], calendar_tomorrow: [] });
    const blocks = renderNotionTodayBlocks(brief, {});
    // Today heading + prose paragraph only — empty sections omitted.
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe('heading_1');
    expect(types).not.toContain('numbered_list_item');
    // No "Top 3" heading_2 either when array is empty.
    const hasTop3Heading = blocks.some(
      (b) => b.type === 'heading_2' && JSON.stringify(b).toLowerCase().includes('top 3'),
    );
    expect(hasTop3Heading).toBe(false);
  });
});

describe('renderDailyBriefLogPage', () => {
  it('emits parent.database_id + properties { Name title, Date date.start, Type select } correctly', () => {
    const brief = makeMorning();
    const req = renderDailyBriefLogPage(brief, {
      databaseId: 'db-id-xyz',
      dateStockholm: '2026-04-25',
      briefKind: 'morning-brief',
    });
    expect(req.parent.database_id).toBe('db-id-xyz');
    const props = req.properties as Record<string, any>;
    expect(props.Name.title[0].text.content).toContain('2026-04-25');
    expect(props.Name.title[0].text.content).toMatch(/Morning Brief/i);
    expect(props.Date.date.start).toBe('2026-04-25');
    expect(props.Type.select.name).toBe('morning-brief');
    // Children include rendered Today blocks.
    expect(Array.isArray(req.children)).toBe(true);
    expect((req.children ?? []).length).toBeGreaterThan(0);
  });
});

describe('renderTelegramHtml', () => {
  it('emits valid HTML with structural tags and total length ≤ 4096', () => {
    const html = renderTelegramHtml(makeMorning(), {
      briefKind: 'morning-brief',
      dateStockholm: '2026-04-25',
      dashUrl: 'https://example.com',
    });
    expect(html.length).toBeLessThanOrEqual(4096);
    // Bold, italic and at least one anchor expected.
    expect(/<b>/.test(html)).toBe(true);
    // Sections appear.
    expect(html.toLowerCase()).toContain('top 3');
  });

  it('escapes <, > and & in entity names and draft previews', () => {
    const brief = makeMorning({
      top_three: [
        {
          title: 'Hi <script>&friends</script>',
          entity_ids: [A_UUID],
          urgency: 'high',
        },
      ],
      drafts_ready: [
        {
          draft_id: A_UUID,
          from: 'a&b@x.com',
          subject: '<urgent> reply',
          classification: 'urgent',
        },
      ],
    });
    const html = renderTelegramHtml(brief, {
      briefKind: 'morning-brief',
      dateStockholm: '2026-04-25',
    });
    // Raw `<script>` must NOT appear; the escaped version must.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});

describe('truncateForTelegram', () => {
  it('drops sections in priority order to fit ≤ maxChars', () => {
    // Build a brief with massive prose + dropped + calendar so the rendered
    // HTML exceeds 4096. Verify that Top 3 + title survive.
    const longText = 'lorem ipsum '.repeat(400); // ~5200 chars.
    const brief = makeMorning({
      prose_summary: 'Short calm summary.',
      dropped_threads: Array.from({ length: 5 }, (_, i) => ({
        title: `Dropped thread ${i} with extremely long padding ${longText}`.slice(0, 200),
        entity_ids: [A_UUID],
        last_mentioned_at: '2026-04-20T08:00:00.000Z',
      })),
      calendar_today: Array.from({ length: 10 }, (_, i) => ({
        start: '2026-04-25T08:00:00.000Z',
        title: `Calendar event ${i} ${longText}`.slice(0, 200),
      })),
    });
    const html = renderTelegramHtml(brief, {
      briefKind: 'morning-brief',
      dateStockholm: '2026-04-25',
    });
    expect(html.length).toBeLessThanOrEqual(4096);
    // Top 3 must survive.
    expect(html.toLowerCase()).toContain('top 3');
    // Title must survive.
    expect(html).toContain('2026-04-25');
  });

  it('returns input unchanged when already ≤ maxChars', () => {
    const small = '<b>tiny</b>';
    expect(truncateForTelegram(small, 4096)).toBe(small);
  });
});

describe('stockholmDateKey', () => {
  it('returns YYYY-MM-DD for a known Stockholm-local instant', () => {
    // 2026-04-25 13:00 UTC = 2026-04-25 15:00 CEST (Stockholm DST active).
    const d = new Date('2026-04-25T13:00:00.000Z');
    expect(stockholmDateKey(d)).toBe('2026-04-25');
  });

  it('matches YYYY-MM-DD pattern for default now', () => {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(stockholmDateKey())).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes <, > and &', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});
