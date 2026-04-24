/**
 * markdown.test.ts — buildDossierMarkdown shape + section-omission tests.
 *
 * Phase 6 Plan 06-05 Task 1.
 */
import { describe, it, expect } from 'vitest';
import { buildDossierMarkdown } from '../src/markdown.js';
import type { ContextBundle } from '@kos/contracts/context';

function emptyBundle(): ContextBundle {
  return {
    kevin_context: {
      current_priorities: '',
      active_deals: '',
      whos_who: '',
      blocked_on: '',
      recent_decisions: '',
      open_questions: '',
      last_updated: null,
    },
    entity_dossiers: [],
    recent_mentions: [],
    semantic_chunks: [],
    linked_projects: [],
    assembled_markdown: '',
    elapsed_ms: 0,
    cache_hit: false,
    partial: false,
    partial_reasons: [],
  };
}

describe('buildDossierMarkdown', () => {
  it('always emits a Kevin Context heading even when block sections are empty', () => {
    const md = buildDossierMarkdown(emptyBundle());
    expect(md).toContain('## Kevin Context');
  });

  it('omits Entities/Mentions/Semantic/Linked sections when corresponding arrays are empty', () => {
    const md = buildDossierMarkdown(emptyBundle());
    expect(md).not.toContain('## Entities in context');
    expect(md).not.toContain('## Recent mentions');
    expect(md).not.toContain('## Semantic retrieval');
    expect(md).not.toContain('## Linked projects');
  });

  it('renders entity dossier with name + type + meta + seed_context', () => {
    const b = emptyBundle();
    b.entity_dossiers = [
      {
        entity_id: '11111111-1111-1111-1111-111111111111',
        name: 'Damien Heinemann',
        type: 'Person',
        aliases: ['Damien'],
        org: 'Almi Invest',
        role: 'Investment Manager',
        relationship: null,
        status: null,
        seed_context: 'Almi point-of-contact for konvertibellånet.',
        last_touch: '2026-04-20T10:00:00.000Z',
        manual_notes: null,
        confidence: 1,
        source: ['notion'],
        linked_project_ids: [],
        recent_mentions: [],
      },
    ];
    const md = buildDossierMarkdown(b);
    expect(md).toContain('## Entities in context');
    expect(md).toContain('Damien Heinemann');
    expect(md).toContain('Person');
    expect(md).toContain('org=Almi Invest');
    expect(md).toContain('role=Investment Manager');
    expect(md).toContain('aliases=Damien');
    expect(md).toContain('Almi point-of-contact for konvertibellånet.');
  });

  it('renders recent mentions with occurred_at + entity_id + kind', () => {
    const b = emptyBundle();
    b.recent_mentions = [
      {
        capture_id: 'cap-1',
        entity_id: '22222222-2222-2222-2222-222222222222',
        kind: 'voice-capture',
        occurred_at: '2026-04-20T10:00:00.000Z',
        excerpt: 'Pinga Damien om lånet',
      },
    ];
    const md = buildDossierMarkdown(b);
    expect(md).toContain('## Recent mentions');
    expect(md).toContain('2026-04-20T10:00:00.000Z');
    expect(md).toContain('voice-capture');
    expect(md).toContain('Pinga Damien om lånet');
  });

  it('truncates semantic chunk snippets to keep prompt size sane', () => {
    const b = emptyBundle();
    const longSnippet = 'A'.repeat(1000);
    b.semantic_chunks = [
      {
        id: 'doc-1',
        source: 'transcript',
        title: 'Long doc',
        snippet: longSnippet,
        score: 0.95,
        reranker_score: 0.88,
        entity_ids: [],
        indexed_at: '2026-04-20T10:00:00.000Z',
      },
    ];
    const md = buildDossierMarkdown(b);
    expect(md).toContain('## Semantic retrieval');
    // Truncate utility caps at 240 chars + ellipsis.
    expect(md).not.toContain('A'.repeat(500));
    expect(md.length).toBeLessThan(longSnippet.length);
  });

  it('renders linked projects with bolag + status when present', () => {
    const b = emptyBundle();
    b.linked_projects = [
      { project_id: '33333333-3333-3333-3333-333333333333', name: 'Tale Forge', bolag: 'Tale Forge AB', status: 'Active' },
      { project_id: '44444444-4444-4444-4444-444444444444', name: 'Outbehaving', bolag: null, status: null },
    ];
    const md = buildDossierMarkdown(b);
    expect(md).toContain('## Linked projects');
    expect(md).toContain('Tale Forge');
    expect(md).toContain('Tale Forge AB');
    expect(md).toContain('Active');
    expect(md).toContain('Outbehaving');
  });

  it('caps total markdown size — keeps prompt under MAX_MARKDOWN_CHARS', () => {
    const b = emptyBundle();
    // Inject 200 entity dossiers with very long seed_context — easily blows past MAX.
    for (let i = 0; i < 200; i += 1) {
      b.entity_dossiers.push({
        entity_id: `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111`,
        name: `Entity ${i}`,
        type: 'Person',
        aliases: [],
        org: null,
        role: null,
        relationship: null,
        status: null,
        seed_context: 'X'.repeat(500),
        last_touch: null,
        manual_notes: null,
        confidence: 1,
        source: [],
        linked_project_ids: [],
        recent_mentions: [],
      });
    }
    const md = buildDossierMarkdown(b);
    expect(md.length).toBeLessThan(35_000); // 32k cap + truncation tail
    expect(md).toContain('truncated');
  });

  it('Kevin Context section omits subsections that are empty strings', () => {
    const b = emptyBundle();
    b.kevin_context.current_priorities = 'Tale Forge launch';
    // active_deals/whos_who/etc remain ''
    const md = buildDossierMarkdown(b);
    expect(md).toContain('### Current priorities');
    expect(md).toContain('Tale Forge launch');
    expect(md).not.toContain("### Who's who");
    expect(md).not.toContain('### Active deals / threads');
  });
});
