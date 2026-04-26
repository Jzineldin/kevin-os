/**
 * @kos/contracts — Phase 10 migration schema tests (Plan 10-00).
 *
 * Five behaviour cases covering every Zod schema introduced for Phase 10:
 *   1. ClassifyPayloadSchema accepts both minimal and rich passthrough payloads
 *   2. DiscordChannelMessageSchema validates the REST message shape
 *   3. VpsServiceInventorySchema validates the freeze-script inventory export
 *   4. EventLogRowSchema validates a row read from the `event_log` table
 *   5. EventLogKindSchema rejects unknown kinds (type-tightening guarantee)
 */
import { describe, it, expect } from 'vitest';
import {
  ClassifyPayloadSchema,
  ClassifyAdapterResultSchema,
  DiscordChannelMessageSchema,
  VpsServiceInventorySchema,
  EventLogRowSchema,
  EventLogKindSchema,
} from '../src/migration.js';

describe('ClassifyPayloadSchema', () => {
  it('accepts a minimal payload with just title', () => {
    const out = ClassifyPayloadSchema.safeParse({ title: 'Hej' });
    expect(out.success).toBe(true);
  });

  it('accepts a fully-populated VPS payload + arbitrary passthrough fields', () => {
    const out = ClassifyPayloadSchema.safeParse({
      title: 'Hej',
      subject: 'Email subject',
      is_duplicate: false,
      already_processed: false,
      // arbitrary VPS-side keyword args; passthrough must keep them.
      legacy_priority: 'P2',
      legacy_tags: ['inbox', 'morning'],
    });
    expect(out.success).toBe(true);
    if (out.success) {
      const data = out.data as Record<string, unknown>;
      expect(data['legacy_priority']).toBe('P2');
    }
  });

  it('emits a valid ClassifyAdapterResult shape', () => {
    const out = ClassifyAdapterResultSchema.safeParse({
      capture_id: '01J9N5XGTYQH2JD7VWF8RKCAB7',
      emitted_at: '2026-04-25T08:00:00.000Z',
      source: 'vps-classify-migration-adapter',
    });
    expect(out.success).toBe(true);
  });
});

describe('DiscordChannelMessageSchema', () => {
  it('validates a Discord REST message', () => {
    const out = DiscordChannelMessageSchema.safeParse({
      id: '1234567890123456789',
      channel_id: '9876543210987654321',
      author: { id: '111', username: 'kevin', bot: false },
      content: 'brain-dump: ship plan 10',
      timestamp: '2026-04-25T08:30:00.000+00:00',
    });
    expect(out.success).toBe(true);
  });

  it('rejects a message missing the author block', () => {
    const out = DiscordChannelMessageSchema.safeParse({
      id: '1',
      channel_id: '2',
      content: 'no author',
      timestamp: '2026-04-25T08:30:00.000Z',
    });
    expect(out.success).toBe(false);
  });
});

describe('VpsServiceInventorySchema', () => {
  it('validates a freeze-script inventory export', () => {
    const out = VpsServiceInventorySchema.safeParse({
      discovered_at: '2026-04-25T07:00:00.000Z',
      host: 'kos-vps-frozen',
      services: [
        {
          unit_name: 'classify_and_save.py',
          unit_type: 'python-script',
          state: 'inactive',
          replaced_by: 'arn:aws:lambda:eu-north-1:000000000000:function:KosMigrationVpsClassifyMigration',
        },
        {
          unit_name: 'n8n.service',
          unit_type: 'n8n-daemon',
          state: 'failed',
          replaced_by: null,
        },
      ],
    });
    expect(out.success).toBe(true);
  });
});

describe('EventLogRowSchema + EventLogKindSchema', () => {
  it('validates a row from the event_log table', () => {
    const out = EventLogRowSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      owner_id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      kind: 'brain-db-archived',
      detail: { db_id: '8a3...', archived_to: 's3://kos-archive/brain/...' },
      occurred_at: '2026-04-25T07:00:00.000+00:00',
      actor: 'plan-10-03',
    });
    expect(out.success).toBe(true);
  });

  it('EventLogKindSchema rejects an unknown kind', () => {
    const out = EventLogKindSchema.safeParse('not-a-real-kind');
    expect(out.success).toBe(false);
  });

  it('EventLogKindSchema accepts every Phase-10 kind', () => {
    const kinds = [
      'brain-db-archived',
      'vps-service-stopped',
      'vps-service-disabled',
      'vps-powered-down',
      'hetzner-snapshot-taken',
      'hetzner-snapshot-deleted',
      'n8n-workflows-archived',
      'n8n-stopped',
      'discord-listener-cutover',
      'classify-adapter-cutover',
      'telegram-webhook-retest',
    ] as const;
    for (const k of kinds) {
      expect(EventLogKindSchema.safeParse(k).success).toBe(true);
    }
  });
});
