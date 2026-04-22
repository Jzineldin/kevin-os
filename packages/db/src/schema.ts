import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ownerId } from './owner.js';

/**
 * KOS Drizzle schema — eight tables, every one with `owner_id`.
 *
 * - ENT-01 `entity_index` mirrors Notion Entities 13 fields. Notion = source of
 *   truth; Postgres = derived index. `embedding` column is created now to dodge
 *   RESEARCH Pitfall 5 (Drizzle ALTER TABLE pgvector gotcha); it's populated in
 *   Phase 6.
 * - ENT-02 `project_index` mirrors Notion Projects.
 * - D-08 / D-11 `notion_indexer_cursor` tracks per-DB cursor state for the four
 *   watched DBs (entities, projects, kevin_context, command_center).
 * - `agent_runs` is durable audit for every agent + indexer invocation (first
 *   consumer is Plan 04's notion-indexer).
 * - `mention_events` is the Phase 2 write target for the entity resolver.
 * - `event_log` is the cross-phase audit stream (stack deploys, VPS freeze
 *   runs, archive-not-delete events).
 * - D-13 `telegram_inbox_queue` holds quiet-hours-suppressed Telegram sends.
 * - MEM-02 `kevin_context` stores Notion Kevin Context page sections for
 *   prompt-cache-ready assembly from Phase 2 onward.
 */

// ENT-01: mirror Notion Entities 13 fields. Notion is source of truth, Postgres is derived index.
export const entityIndex = pgTable(
  'entity_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    notionPageId: text('notion_page_id').notNull().unique(),
    name: text('name').notNull(),
    aliases: text('aliases').array().default(sql`ARRAY[]::text[]`),
    type: text('type').notNull(), // Person | Project | Company | Document
    org: text('org'),
    role: text('role'),
    relationship: text('relationship'),
    status: text('status'),
    linkedProjects: text('linked_projects').array().default(sql`ARRAY[]::text[]`),
    seedContext: text('seed_context'),
    lastTouch: timestamp('last_touch', { withTimezone: true }),
    manualNotes: text('manual_notes'),
    confidence: integer('confidence'),
    source: text('source').array().default(sql`ARRAY[]::text[]`),
    // Phase 6 populates this; column created here so we never ALTER TABLE for a vector column (Pitfall 5).
    embedding: vector('embedding', { dimensions: 1536 }),
    notionLastEditedTime: timestamp('notion_last_edited_time', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOwnerType: index('entity_index_by_owner_type').on(t.ownerId, t.type),
    byNotionPage: uniqueIndex('entity_index_notion_page_uq').on(t.notionPageId),
  }),
);

// ENT-02
export const projectIndex = pgTable(
  'project_index',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    notionPageId: text('notion_page_id').notNull().unique(),
    name: text('name').notNull(),
    bolag: text('bolag'),
    status: text('status'),
    description: text('description'),
    linkedPeople: text('linked_people').array().default(sql`ARRAY[]::text[]`),
    seedContext: text('seed_context'),
    notionLastEditedTime: timestamp('notion_last_edited_time', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOwner: index('project_index_by_owner').on(t.ownerId),
  }),
);

// D-08 cursor per watched DB; D-11: entities, projects, kevin_context, command_center in Phase 1.
export const notionIndexerCursor = pgTable('notion_indexer_cursor', {
  ownerId: ownerId(),
  dbId: text('db_id').primaryKey(), // Notion DB UUID
  dbKind: text('db_kind').notNull(), // 'entities' | 'projects' | 'kevin_context' | 'command_center'
  lastCursorAt: timestamp('last_cursor_at', { withTimezone: true })
    .notNull()
    .default(sql`to_timestamp(0)`),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastError: text('last_error'),
});

// Durable audit for every agent + indexer run (first consumer = Plan 04 notion-indexer).
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    captureId: text('capture_id'), // ULID
    agentName: text('agent_name').notNull(),
    inputHash: text('input_hash'),
    outputJson: jsonb('output_json'),
    tokensInput: integer('tokens_input'),
    tokensOutput: integer('tokens_output'),
    // Cost stored in microcents to avoid float; Phase 7 cost alarms read this.
    costUsd: integer('cost_usd_microcents'),
    status: text('status').notNull(), // 'ok' | 'error' | 'retried'
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    byCapture: index('agent_runs_by_capture').on(t.captureId),
    byOwnerStart: index('agent_runs_by_owner_started').on(t.ownerId, t.startedAt),
  }),
);

// Phase 2 write target; table created now for forward-compat.
export const mentionEvents = pgTable(
  'mention_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    entityId: uuid('entity_id').references(() => entityIndex.id),
    captureId: text('capture_id'),
    source: text('source').notNull(), // 'telegram' | 'email' | 'granola' | 'manual' | ...
    context: text('context'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEntityTime: index('mention_events_by_entity_time').on(t.entityId, t.occurredAt),
  }),
);

// Cross-phase audit log (archive-not-delete tracking, stack deploy events, VPS freeze runs, etc.).
export const eventLog = pgTable(
  'event_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    kind: text('kind').notNull(),
    detail: jsonb('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byKind: index('event_log_by_kind').on(t.kind, t.occurredAt),
  }),
);

// D-13: quiet-hours suppressed Telegram messages queue here; Phase 2 `push-telegram`
// Lambda drains on morning brief.
export const telegramInboxQueue = pgTable('telegram_inbox_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: ownerId(),
  body: text('body').notNull(),
  reason: text('reason').notNull(), // 'cap-exceeded' | 'quiet-hours'
  queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

// MEM-02: Kevin Context sections mirrored from Notion Kevin Context page —
// populated by notion-indexer for dbKind='kevin_context'. Enables prompt-cache-ready
// assembly in Phase 2+.
export const kevinContext = pgTable(
  'kevin_context',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    notionBlockId: text('notion_block_id').notNull().unique(),
    sectionHeading: text('section_heading').notNull(), // e.g. 'Current priorities'
    sectionBody: text('section_body').notNull(),
    notionLastEditedTime: timestamp('notion_last_edited_time', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOwnerHeading: index('kevin_context_by_owner_heading').on(t.ownerId, t.sectionHeading),
  }),
);
