/**
 * Entity-response contract shape tests.
 *
 * Full live query test (joins across entity_index, project_index,
 * mention_events) lives under e2e. Here we only validate the contract.
 */
import { describe, expect, it } from 'vitest';
import { EntityResponseSchema } from '@kos/contracts/dashboard';

describe('entity response schema', () => {
  it('accepts a Phase-3 seeded entity shape', () => {
    const e = {
      id: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      name: 'Damien',
      type: 'Person',
      aliases: ['Dam'],
      org: 'Tale Forge',
      role: 'Investor',
      relationship: 'advisor',
      status: 'active',
      seed_context: 'Lead investor in Tale Forge seed round.',
      manual_notes: null,
      last_touch: '2026-04-22T12:00:00Z',
      confidence: 90,
      linked_projects: [],
      stats: {
        first_contact: '2024-11-01T10:00:00Z',
        total_mentions: 42,
        active_threads: 3,
      },
      ai_block: { body: 'Cached summary.', cached_at: null },
    };
    expect(() => EntityResponseSchema.parse(e)).not.toThrow();
  });

  it('accepts null last_touch and null ai_block', () => {
    const e = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Newcomer',
      type: 'Person',
      aliases: [],
      org: null,
      role: null,
      relationship: null,
      status: 'active',
      seed_context: null,
      manual_notes: null,
      last_touch: null,
      confidence: null,
      linked_projects: [],
      stats: { first_contact: null, total_mentions: 0, active_threads: 0 },
      ai_block: null,
    };
    expect(() => EntityResponseSchema.parse(e)).not.toThrow();
  });

  it('rejects an invalid entity type', () => {
    const e = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'X',
      type: 'Alien',
      aliases: [],
      org: null,
      role: null,
      relationship: null,
      status: 'active',
      seed_context: null,
      manual_notes: null,
      last_touch: null,
      confidence: null,
      linked_projects: [],
      stats: { first_contact: null, total_mentions: 0, active_threads: 0 },
      ai_block: null,
    };
    expect(() => EntityResponseSchema.parse(e)).toThrow();
  });
});
