/**
 * Brief — v4 Morning Brief hero block on /today.
 *
 * Visual reference: mockup-v4.html § .hero-brief
 *
 * The one visually distinct surface on the Today view — deliberately
 * different treatment from the uniform .panel chrome so the eye lands
 * here first. Soft amber radial glow in the top-right, no bordered
 * header, 17px body, 860px max reading width.
 *
 * Body rendering (polish pass 2026-04-27):
 *   The backend ships the brief as plaintext with semantic line breaks
 *   (see services/dashboard-api/src/handlers/today.ts loadBrief):
 *     - `\n\n` between sections / paragraphs
 *     - `\n` between sibling list items
 *     - lines beginning with `• ` are bullet items (numbered_list_item
 *       and bulleted_list_item both get this prefix server-side so the
 *       client renders a single bullet style).
 *     - lines sandwiched between blank lines and shorter than ~80 chars
 *       are treated as section headings.
 *
 *   The prior revision of this file rendered `body` inside a single
 *   <p> which collapsed every \n — the "one big clumsy thing" problem
 *   Kevin flagged on 2026-04-27. The parser below preserves structure
 *   without requiring a server-contract change.
 *
 * Phase 3 still serves a placeholder body until Phase 7 AUTO-01 ships
 * the real generated brief. The brief-dot pulsing var(--color-success)
 * signals pipeline health even when the body is placeholder.
 */
import { format, parseISO } from 'date-fns';
import type { TodayBrief } from '@kos/contracts/dashboard';

const PLACEHOLDER =
  'Brief generated daily at 07:00 — ships with Phase 7.';

export function Brief({ brief }: { brief: TodayBrief | null }) {
  const body = brief?.body ?? PLACEHOLDER;
  const hasBrief = Boolean(brief?.body);
  const generatedAt = brief?.generated_at ?? null;
  const blocks = parseBriefBody(body);

  return (
    <article
      className="hero-brief"
      data-slot="hero-brief"
      aria-label="AI Morning Brief"
    >
      <header className="hero-brief-meta">
        <span className="dot" aria-hidden />
        <span>AI Morning Brief</span>
        <span className="sub">{formatGeneratedAt(generatedAt)}</span>
      </header>

      <div className="hero-brief-body">
        {blocks.map((block, i) => (
          <BriefBlock key={i} block={block} index={i} />
        ))}
      </div>

      {hasBrief ? (
        <div className="hero-brief-foot">
          <span>
            <span className="k">Sources</span>{' '}
            <span className="v">gmail · calendar · notion</span>
          </span>
          {generatedAt ? (
            <span>
              <span className="k">Generated</span>{' '}
              <span className="v">{formatGeneratedAt(generatedAt)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Brief body parser
// ─────────────────────────────────────────────────────────────────────────────

type BriefBlockT =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

/**
 * Parse the plaintext brief body into structured blocks for rendering.
 * Keeps the parser conservative — anything ambiguous falls through as
 * a paragraph so we never hide content.
 */
function parseBriefBody(body: string): BriefBlockT[] {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Split on blank lines first → semantic paragraphs/sections
  const chunks = normalized.split(/\n{2,}/);
  const blocks: BriefBlockT[] = [];

  for (const raw of chunks) {
    const chunk = raw.trim();
    if (!chunk) continue;

    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);

    // Consecutive bullet lines → list block
    const allBullets = lines.every((l) => l.startsWith('• '));
    if (allBullets && lines.length > 0) {
      blocks.push({
        kind: 'list',
        items: lines.map((l) => l.replace(/^•\s+/, '')),
      });
      continue;
    }

    // Single short line, no trailing punctuation → heading
    if (
      lines.length === 1 &&
      lines[0]!.length < 80 &&
      !/[.!?]$/.test(lines[0]!)
    ) {
      blocks.push({ kind: 'heading', text: lines[0]! });
      continue;
    }

    // Mixed content: render each line as its own paragraph so server-
    // emitted `\n` still creates visual breaks within a section.
    for (const line of lines) {
      if (line.startsWith('• ')) {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === 'list') {
          last.items.push(line.replace(/^•\s+/, ''));
        } else {
          blocks.push({
            kind: 'list',
            items: [line.replace(/^•\s+/, '')],
          });
        }
      } else {
        blocks.push({ kind: 'paragraph', text: line });
      }
    }
  }

  return blocks;
}

function BriefBlock({ block, index }: { block: BriefBlockT; index: number }) {
  switch (block.kind) {
    case 'heading':
      return (
        <h3
          className="hero-brief-heading"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-text-3)',
            margin: index === 0 ? '0 0 10px' : '18px 0 10px',
          }}
        >
          {block.text}
        </h3>
      );
    case 'list':
      return (
        <ol
          className="hero-brief-list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {block.items.map((item, i) => (
            <li
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '22px 1fr',
                gap: 12,
                alignItems: 'baseline',
                fontSize: 15,
                lineHeight: 1.55,
                color: 'var(--color-text)',
              }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-sect-brief)',
                  letterSpacing: '0.04em',
                  lineHeight: 1.7,
                }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
    case 'paragraph':
      return (
        <p
          style={{
            margin: index === 0 ? 0 : '10px 0 0',
            fontSize: 16,
            lineHeight: 1.65,
            color: 'var(--color-text)',
            letterSpacing: '-0.003em',
          }}
        >
          {renderInline(block.text)}
        </p>
      );
  }
}

/**
 * Inline renderer — subtle semantic highlights without requiring the
 * server to ship rich-text. Text between single backticks, or plain
 * entity-like tokens, are not currently marked up; we rely on the
 * brief prompt to emit highlights via Notion rich-text which the
 * server flattens, so inline formatting is preserved only via bold
 * patterns. For now we just render the string — the typography
 * hierarchy from the block parser does the heavy lifting.
 */
function renderInline(text: string): React.ReactNode {
  return text;
}

function formatGeneratedAt(iso: string | null): string {
  if (!iso) return 'pending';
  try {
    return `· ${format(parseISO(iso), 'HH:mm')}`;
  } catch {
    return '';
  }
}
