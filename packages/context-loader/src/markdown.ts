/**
 * buildDossierMarkdown — turn a ContextBundle into a single markdown block
 * injectable into a Bedrock system prompt with `cache_control: ephemeral`.
 *
 * Structure (order matters — cache-stable prefix FIRST so prompt-caching
 * hits on repeated calls):
 *
 *   ## Kevin Context                  ← stable across capture_ids
 *   ## Entities in context            ← varies per call
 *   ## Recent mentions                ← varies per call
 *   ## Semantic retrieval             ← varies per call
 *   ## Linked projects                ← varies per call
 */
import type { ContextBundle } from '@kos/contracts/context';

const MAX_MARKDOWN_CHARS = 32_000;

export function buildDossierMarkdown(bundle: ContextBundle): string {
  const parts: string[] = [];

  parts.push('## Kevin Context');
  parts.push('');
  parts.push(formatKevinContext(bundle.kevin_context));
  parts.push('');

  if (bundle.entity_dossiers.length > 0) {
    parts.push('## Entities in context');
    parts.push('');
    for (const d of bundle.entity_dossiers) {
      parts.push(formatEntity(d));
      parts.push('');
    }
  }

  if (bundle.recent_mentions.length > 0) {
    parts.push('## Recent mentions');
    parts.push('');
    for (const m of bundle.recent_mentions) {
      parts.push(
        `- [${m.occurred_at}] entity=${m.entity_id} kind=${m.kind}${
          m.excerpt ? ` — "${truncate(m.excerpt, 160)}"` : ''
        }`,
      );
    }
    parts.push('');
  }

  if (bundle.semantic_chunks.length > 0) {
    parts.push('## Semantic retrieval');
    parts.push('');
    for (const h of bundle.semantic_chunks) {
      parts.push(
        `- **${h.source}** · ${h.title} · score=${h.score.toFixed(2)}${
          h.reranker_score != null ? ` · rerank=${h.reranker_score.toFixed(2)}` : ''
        }`,
      );
      parts.push(`  > ${truncate(h.snippet, 240)}`);
    }
    parts.push('');
  }

  if (bundle.linked_projects.length > 0) {
    parts.push('## Linked projects');
    parts.push('');
    for (const p of bundle.linked_projects) {
      parts.push(
        `- **${p.name}**${p.bolag ? ` (${p.bolag})` : ''}${p.status ? ` · ${p.status}` : ''}`,
      );
    }
    parts.push('');
  }

  const out = parts.join('\n');
  return out.length > MAX_MARKDOWN_CHARS
    ? `${out.slice(0, MAX_MARKDOWN_CHARS)}\n\n[... truncated ${out.length - MAX_MARKDOWN_CHARS} chars ...]`
    : out;
}

function formatKevinContext(k: ContextBundle['kevin_context']): string {
  const sections: Array<[string, string]> = [
    ['Current priorities', k.current_priorities],
    ['Active deals / threads', k.active_deals],
    ["Who's who", k.whos_who],
    ['Blocked on', k.blocked_on],
    ['Recent decisions', k.recent_decisions],
    ['Open questions', k.open_questions],
  ];
  return sections
    .filter(([, v]) => v.trim().length > 0)
    .map(([label, body]) => `### ${label}\n${body.trim()}`)
    .join('\n\n');
}

function formatEntity(d: ContextBundle['entity_dossiers'][number]): string {
  const head = `### ${d.name} (${d.type})`;
  const meta = [
    d.org ? `org=${d.org}` : null,
    d.role ? `role=${d.role}` : null,
    d.relationship ? `relationship=${d.relationship}` : null,
    d.status ? `status=${d.status}` : null,
    d.aliases.length > 0 ? `aliases=${d.aliases.join(', ')}` : null,
    d.last_touch ? `last_touch=${d.last_touch}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const seed = d.seed_context ? `\n${d.seed_context.trim()}` : '';
  const notes = d.manual_notes ? `\n_Notes:_ ${d.manual_notes.trim()}` : '';
  const mentions =
    d.recent_mentions.length > 0
      ? `\n_Recent mentions:_ ${d.recent_mentions
          .slice(0, 3)
          .map((m) => `${m.kind}@${m.occurred_at}`)
          .join(', ')}`
      : '';
  return `${head}\n${meta}${seed}${notes}${mentions}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
