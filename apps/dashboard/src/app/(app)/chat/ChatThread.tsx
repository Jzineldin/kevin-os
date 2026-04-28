/**
 * ChatThread — renders a list of chat messages with markdown support.
 *
 * Features:
 *   - User messages in light color, assistant in accent
 *   - Markdown rendering (basic: **bold**, _italic_, `code`, links)
 *   - Entity citations are clickable links to /entities/[id]
 *   - Preserves line breaks and code blocks
 */

'use client';

import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ChatMessage } from './types';

export interface ChatThreadProps {
  messages: ChatMessage[];
  onEntityClick?: (entityId: string) => void;
}

function renderMarkdown(text: string, entityLinks?: Map<string, string>): React.ReactNode {
  // Simple markdown: **bold** → <strong>, _italic_ → <em>, `code` → <code>
  // Links: [text](url) → <a>
  // Entity refs from citations are passed as a map of name → id for clickable links

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  // Token regex: bold (**...**), italic (_..._), code (`...`), link ([...](url))
  const tokenRe = /\*\*(.+?)\*\*|_(.+?)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }

    if (match[1]) {
      // **bold**
      parts.push(
        <strong key={`b-${match.index}`} style={{ fontWeight: 700 }}>
          {match[1]}
        </strong>,
      );
    } else if (match[2]) {
      // _italic_
      parts.push(
        <em key={`i-${match.index}`} style={{ fontStyle: 'italic' }}>
          {match[2]}
        </em>,
      );
    } else if (match[3]) {
      // `code`
      parts.push(
        <code
          key={`c-${match.index}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            background: 'color-mix(in srgb, var(--color-text-4) 18%, transparent)',
            padding: '2px 4px',
            borderRadius: 3,
          }}
        >
          {match[3]}
        </code>,
      );
    } else if (match[4] && match[5]) {
      // [text](url)
      const linkText = match[4];
      const href = match[5];
      // If href is an entity name and we have a mapping, use entity click
      const isEntity = entityLinks?.has(linkText);
      const entityId = isEntity ? entityLinks?.get(linkText) : undefined;
      parts.push(
        <a
          key={`l-${match.index}`}
          href={isEntity ? undefined : href}
          onClick={isEntity && entityId ? (e) => { e.preventDefault(); } : undefined}
          style={{
            color: 'var(--color-sect-drafts)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {linkText}
        </a>,
      );
    }

    lastIdx = tokenRe.lastIndex;
  }

  // Remaining text
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return parts.length > 0 ? parts : text;
}

export function ChatThread({ messages, onEntityClick }: ChatThreadProps) {
  const entityLinkMap = useMemo(() => {
    // Build a map of entity names → ids from all citations across all messages
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.citations) {
        for (const c of msg.citations) {
          map.set(c.name, c.entity_id);
        }
      }
    }
    return map;
  }, [messages]);

  return (
    <>
      {messages.map((msg, idx) => (
        <div
          key={idx}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                textTransform: 'uppercase',
                color:
                  msg.role === 'user'
                    ? 'var(--color-text-3)'
                    : 'var(--color-sect-drafts)',
                letterSpacing: '0.5px',
              }}
            >
              {msg.role === 'user' ? 'You' : 'KOS'}
            </span>
          </div>
          <p
            style={{
              color: 'var(--color-text)',
              fontSize: 'var(--text-body)',
              lineHeight: 1.6,
              margin: 0,
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              fontFamily: msg.content.includes('```') ? 'var(--font-mono)' : 'inherit',
            }}
          >
            {renderMarkdown(msg.content, entityLinkMap)}
          </p>
          {msg.citations && msg.citations.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 8,
              }}
            >
              {msg.citations.map((c) => (
                <button
                  key={c.entity_id}
                  onClick={() => onEntityClick?.(c.entity_id)}
                  type="button"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 10px',
                    borderRadius: 4,
                    border: '1px solid color-mix(in srgb, var(--color-sect-entities) 34%, transparent)',
                    background: 'color-mix(in srgb, var(--color-sect-entities) 12%, transparent)',
                    color: 'var(--color-sect-entities)',
                    fontSize: 'var(--text-sm)',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'color-mix(in srgb, var(--color-sect-entities) 20%, transparent)';
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      'color-mix(in srgb, var(--color-sect-entities) 50%, transparent)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'color-mix(in srgb, var(--color-sect-entities) 12%, transparent)';
                    (e.currentTarget as HTMLButtonElement).style.borderColor =
                      'color-mix(in srgb, var(--color-sect-entities) 34%, transparent)';
                  }}
                >
                  {c.name}
                  <ExternalLink size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
