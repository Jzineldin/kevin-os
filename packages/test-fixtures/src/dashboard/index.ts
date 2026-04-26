/**
 * @kos/test-fixtures/dashboard — deterministic fixture factories for
 * Phase 3 Wave-1+ tests. Every factory returns data that `z.parse`-validates
 * against the matching @kos/contracts/dashboard schema.
 *
 * Keep the surface small and composable. Tests should override only the
 * fields they care about: `makeTodayResponse({ priorities: [] })`.
 */
import type {
  CaptureResponse,
  EntityResponse,
  InboxItem,
  InboxItemKind,
  MergeRequest,
  SseEvent,
  SseEventKind,
  TimelinePage,
  TodayBrief,
  TodayDraft,
  TodayDroppedThread,
  TodayMeeting,
  TodayPriority,
  TodayResponse,
} from '@kos/contracts/dashboard';

// ULIDs used by tests — valid Crockford base32, 26 chars.
const ULID_ALPHA = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_BRAVO = '01HZ00000000000000000000AA';

// Stable fixture UUIDs — easy to grep in test output.
const UUID_ENTITY = '11111111-2222-3333-4444-555555555555';
const UUID_ENTITY_2 = '22222222-3333-4444-5555-666666666666';

const ISO = '2026-04-23T08:00:00.000Z';

export function makeTodayBrief(overrides: Partial<TodayBrief> = {}): TodayBrief {
  return {
    body: 'Morning. 3 priorities today. No blocked threads.',
    generated_at: ISO,
    ...overrides,
  };
}

export function makeTodayPriority(overrides: Partial<TodayPriority> = {}): TodayPriority {
  return {
    id: 'prio-1',
    title: 'Ship Phase 3 dashboard MVP',
    bolag: 'tale-forge',
    entity_id: UUID_ENTITY,
    entity_name: 'Damien',
    ...overrides,
  };
}

export function makeTodayDraft(overrides: Partial<TodayDraft> = {}): TodayDraft {
  return {
    id: 'draft-1',
    entity: 'Christina',
    preview: 'Hej Christina — bifogat …',
    from: 'christina@example.com',
    subject: 'Re: Q2 roadmap',
    received_at: ISO,
    ...overrides,
  };
}

export function makeTodayDroppedThread(
  overrides: Partial<TodayDroppedThread> = {},
): TodayDroppedThread {
  return {
    id: 'dropped-1',
    entity_id: UUID_ENTITY_2,
    entity: 'Almi',
    age_days: 9,
    bolag: 'tale-forge',
    ...overrides,
  };
}

export function makeTodayMeeting(overrides: Partial<TodayMeeting> = {}): TodayMeeting {
  return {
    id: 'meet-1',
    title: 'Tale Forge standup',
    start_at: ISO,
    end_at: '2026-04-23T08:30:00.000Z',
    is_now: false,
    bolag: 'tale-forge',
    ...overrides,
  };
}

export function makeTodayResponse(overrides: Partial<TodayResponse> = {}): TodayResponse {
  return {
    brief: makeTodayBrief(),
    priorities: [makeTodayPriority()],
    drafts: [makeTodayDraft()],
    dropped: [makeTodayDroppedThread()],
    meetings: [makeTodayMeeting()],
    // Phase 11 Plan 11-04 made captures_today + channels required (with
    // `.default([])` at the schema level). Default to empty arrays here so
    // fixture types satisfy the contract without forcing every caller to
    // pass them.
    captures_today: [],
    channels: [],
    ...overrides,
  };
}

export function makeEntityResponse(overrides: Partial<EntityResponse> = {}): EntityResponse {
  return {
    id: UUID_ENTITY,
    name: 'Damien',
    type: 'Person',
    aliases: ['Damien L.'],
    org: 'Tale Forge AB',
    role: 'Co-founder',
    relationship: 'partner',
    status: 'active',
    seed_context: 'Founding team; product + growth.',
    manual_notes: null,
    last_touch: ISO,
    confidence: 0.98,
    linked_projects: [
      { id: UUID_ENTITY_2, name: 'Tale Forge v2', bolag: 'tale-forge' },
    ],
    stats: {
      first_contact: '2025-09-01T12:00:00.000Z',
      total_mentions: 42,
      active_threads: 3,
    },
    ai_block: { body: 'Core co-founder. Drives product direction.', cached_at: ISO },
    ...overrides,
  };
}

export function makeTimelinePage(overrides: Partial<TimelinePage> = {}): TimelinePage {
  return {
    rows: [
      {
        id: 'row-1',
        kind: 'mention',
        occurred_at: ISO,
        source: 'telegram-voice',
        context: 'Damien pushed the new onboarding flow.',
        capture_id: ULID_ALPHA,
        href: null,
      },
    ],
    next_cursor: null,
    ...overrides,
  };
}

export function makeInboxItem(
  kind: InboxItemKind = 'draft_reply',
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: 'inbox-1',
    kind,
    title:
      kind === 'draft_reply'
        ? 'Draft reply to Christina'
        : kind === 'entity_routing'
          ? 'Ambiguous entity: "Kev"'
          : kind === 'new_entity'
            ? 'New entity detected: "Astrid"'
            : 'Resume partial merge',
    preview: 'Hej — tack för mejlet …',
    bolag: 'tale-forge',
    entity_id: UUID_ENTITY,
    merge_id: kind === 'merge_resume' ? ULID_BRAVO : null,
    payload: { draft: 'Hej — tack för …' },
    created_at: ISO,
    ...overrides,
  };
}

export function makeMergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    source_id: UUID_ENTITY_2,
    merge_id: ULID_ALPHA,
    diff: { name: { from: 'Damian', to: 'Damien' } },
    ...overrides,
  };
}

export function makeSseEvent(
  kind: SseEventKind = 'inbox_item',
  overrides: Partial<SseEvent> = {},
): SseEvent {
  return {
    kind,
    id: 'evt-1',
    entity_id: UUID_ENTITY,
    ts: ISO,
    ...overrides,
  };
}

export function makeCaptureResponse(overrides: Partial<CaptureResponse> = {}): CaptureResponse {
  return {
    capture_id: ULID_ALPHA,
    received_at: ISO,
    ...overrides,
  };
}
