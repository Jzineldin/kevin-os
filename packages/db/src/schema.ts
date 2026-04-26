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
  primaryKey,
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
    // Phase 2 Migration 0003 resized this from 1536 → 1024 for Cohere Embed Multilingual v3 (D-05).
    embedding: vector('embedding', { dimensions: 1024 }),
    // Phase 2 Migration 0003 added this column for provenance (which model produced this vector).
    embeddingModel: text('embedding_model'),
    // Plan 02-08 Migration 0006: sha256 of D-08 entity text that produced `embedding`.
    // Used by notion-indexer to skip re-embed when source text is unchanged.
    embedHash: text('embed_hash'),
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
// Phase 10 (migration 0021) added `actor` and the `event_log_owner_at_idx`
// index for per-owner audit-timeline reads. The `kind` column stays open-
// text in the DB; the application-layer enum lives in
// `@kos/contracts/migration` (EventLogKindSchema).
export const eventLog = pgTable(
  'event_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    kind: text('kind').notNull(),
    detail: jsonb('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Phase 10 — plan id or operator handle that wrote the row. */
    actor: text('actor').notNull(),
  },
  (t) => ({
    byKind: index('event_log_by_kind').on(t.kind, t.occurredAt),
    byOwnerAt: index('event_log_owner_at_idx').on(t.ownerId, t.occurredAt),
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

// ENT-07: entity merge audit + resume state machine (Phase 3 Plan 01 migration 0007).
// Every Notion→RDS manual merge writes one row per state transition. The
// merge-resume Lambda reads (state, merge_id) to pick up partial merges
// exactly where they failed without replaying side-effects.
//
// `state` is CHECK-constrained at the SQL layer to the 11 values in 0007;
// Drizzle type is plain `text` (no enum column — matches existing repo
// convention for CHECK-constrained text columns like agent_runs.status).
export const entityMergeAudit = pgTable(
  'entity_merge_audit',
  {
    mergeId: text('merge_id').primaryKey(), // ULID string
    ownerId: ownerId(),
    sourceEntityId: uuid('source_entity_id')
      .notNull()
      .references(() => entityIndex.id),
    targetEntityId: uuid('target_entity_id')
      .notNull()
      .references(() => entityIndex.id),
    initiatedBy: text('initiated_by').notNull().default('kevin'),
    state: text('state').notNull(),
    diff: jsonb('diff').notNull(),
    errorMessage: text('error_message'),
    notionArchivedAt: timestamp('notion_archived_at', { withTimezone: true }),
    rdsUpdatedAt: timestamp('rds_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    byState: index('entity_merge_audit_by_state').on(t.state, t.createdAt),
    bySource: index('entity_merge_audit_by_source').on(t.sourceEntityId),
    byOwner: index('entity_merge_audit_by_owner').on(t.ownerId, t.createdAt),
  }),
);

// UI-04 data source: inbox_index mirrors the KOS Inbox Notion DB (Phase 3
// Plan 01 migration 0008). The notion-indexer upserts rows here; the
// dashboard-api reads them; the 0009 trigger emits pg_notify('kos_output',
// { kind: 'inbox_item', id, ts }) on INSERT for SSE fan-out.
//
// `id` matches the Notion page id verbatim so upsert-on-notion-edit is
// idempotent via INSERT ... ON CONFLICT (id) DO UPDATE.
export const inboxIndex = pgTable(
  'inbox_index',
  {
    id: text('id').primaryKey(), // Notion page id
    ownerId: ownerId(),
    kind: text('kind').notNull(), // 'draft_reply' | 'entity_routing' | 'new_entity' | 'merge_resume'
    title: text('title').notNull(),
    preview: text('preview').notNull(),
    bolag: text('bolag'), // 'tale-forge' | 'outbehaving' | 'personal' | null
    entityId: uuid('entity_id').references(() => entityIndex.id),
    mergeId: text('merge_id').references(() => entityMergeAudit.mergeId),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'), // 'pending'|'approved'|'skipped'|'rejected'|'archived'
    notionLastEditedAt: timestamp('notion_last_edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pending: index('inbox_index_pending').on(t.ownerId, t.createdAt),
    byEntity: index('inbox_index_by_entity').on(t.entityId),
    byMerge: index('inbox_index_by_merge').on(t.mergeId),
  }),
);

// ---------------------------------------------------------------------------
// Phase 6 Migration 0012: dossier cache (D-17 / D-18 / D-19)
//
// Postgres-backed cache for assembled entity dossiers. Composite PK
// (entity_id, owner_id) preserves the multi-user forward-compat invariant
// from Locked Decision #13 even though v1 is single-user. Invalidation
// is trigger-driven via `trg_entity_dossiers_cached_invalidate` on
// mention_events INSERT (D-18); TTL belt-and-braces via expires_at column
// read at query time. Bundle is the full ContextBundle JSON minus
// kevin_context (which is concat'd at call time).
//
// The materialized view `entity_timeline` (MEM-04) is intentionally NOT
// modeled here — Drizzle does not represent materialized views as first
// class objects; queries against it use raw `pool.query` SQL.
// See: packages/db/drizzle/0012_phase_6_dossier_cache_and_timeline_mv.sql
// ---------------------------------------------------------------------------
export const entityDossiersCached = pgTable(
  'entity_dossiers_cached',
  {
    entityId: uuid('entity_id').notNull(),
    ownerId: ownerId(),
    lastTouchHash: text('last_touch_hash').notNull(),
    bundle: jsonb('bundle').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entityId, t.ownerId] }),
    byExpires: index('idx_entity_dossiers_cached_expires').on(t.expiresAt),
    byOwner: index('idx_entity_dossiers_cached_owner').on(t.ownerId, t.entityId),
  }),
);

// ---------------------------------------------------------------------------
// Phase 6 Migration 0012: per-Azure-indexer-source incremental sync cursor.
//
// Each `services/azure-search-indexer-*` Lambda reads + writes a row keyed
// by `key` ('azure-indexer-entities', 'azure-indexer-projects',
// 'azure-indexer-transcripts', 'azure-indexer-daily-brief') to track the
// `updated_at` watermark of the last-processed source row. First-run cursor
// is NULL (=> fetch-all-then-advance).
// ---------------------------------------------------------------------------
export const azureIndexerCursor = pgTable('azure_indexer_cursor', {
  key: text('key').primaryKey(),
  ownerId: ownerId(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Phase 4 Migration 0016: email pipeline + agent dead letter (3 tables).
//
// `email_drafts` is the source of truth for every draft generated by
// email-triage (AGT-05). Idempotency is enforced by UNIQUE (account_id,
// message_id) — replays of EmailEngine `messageNew` webhooks never
// double-insert. `status` is a CHECK-constrained text column matching the
// SQL layer ('pending_triage','draft','edited','approved','skipped','sent',
// 'failed'); Drizzle type is plain `text` per repo convention.
//
// `email_send_authorizations` is the single-use token gating ses:SendRawEmail.
// dashboard-api Approve route INSERTs; email-sender SELECT-FOR-UPDATE,
// SES sends, UPDATEs consumed_at + send_result.
//
// `agent_dead_letter` is the durable record written by
// services/_shared/with-timeout-retry.ts on final tool-call failure. The
// dashboard surfaces these via SSE.
//
// See: packages/db/drizzle/0016_phase_4_email_and_dead_letter.sql
// ---------------------------------------------------------------------------
export const emailDrafts = pgTable(
  'email_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    captureId: text('capture_id').notNull(), // ULID from inbound capture
    accountId: text('account_id').notNull(), // 'kevin-elzarka' | 'kevin-taleforge' | 'forward'
    messageId: text('message_id').notNull(),
    fromEmail: text('from_email').notNull(),
    toEmail: text('to_email').array().notNull().default(sql`'{}'::text[]`),
    subject: text('subject'),
    classification: text('classification').notNull(), // CHECK at SQL layer
    draftBody: text('draft_body'),
    draftSubject: text('draft_subject'),
    status: text('status').notNull().default('draft'), // CHECK at SQL layer
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentMessageId: text('sent_message_id'),
  },
  (t) => ({
    accountMessageUq: uniqueIndex('email_drafts_account_message_uidx').on(
      t.accountId,
      t.messageId,
    ),
    ownerStatus: index('email_drafts_owner_status_idx').on(
      t.ownerId,
      t.status,
      t.receivedAt,
    ),
    ownerClassification: index('email_drafts_owner_classification_idx').on(
      t.ownerId,
      t.classification,
      t.receivedAt,
    ),
  }),
);

export const emailSendAuthorizations = pgTable(
  'email_send_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => emailDrafts.id, { onDelete: 'cascade' }),
    approvedBy: text('approved_by').notNull().default('kevin'),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    sendResult: jsonb('send_result'),
  },
  (t) => ({
    ownerDraft: index('email_send_authorizations_owner_draft_idx').on(
      t.ownerId,
      t.draftId,
    ),
  }),
);

export const agentDeadLetter = pgTable(
  'agent_dead_letter',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    captureId: text('capture_id').notNull(),
    agentRunId: uuid('agent_run_id'),
    toolName: text('tool_name').notNull(),
    errorClass: text('error_class').notNull(),
    errorMessage: text('error_message').notNull(),
    requestPreview: text('request_preview'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    retriedAt: timestamp('retried_at', { withTimezone: true }),
  },
  (t) => ({
    ownerOccurred: index('agent_dead_letter_owner_occurred_idx').on(
      t.ownerId,
      t.occurredAt,
    ),
  }),
);
