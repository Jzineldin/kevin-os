/**
 * /chat — v4 visual-only shell.
 *
 * The persistent ChatBubble (mounted globally in (app)/layout.tsx) opens
 * a quick drawer for ad-hoc questions. This page is the deep-link
 * counterpart: a placeholder until Phase 11-ter wires the conversational
 * backend (Sonnet 4.6 + entity-graph context + tool-use surface).
 *
 * No SSE, no client interactivity — pure RSC shell with informative copy
 * per D-12 (calm empty states). Wrapped in <Panel tone="drafts" /> so it
 * inherits the v4 violet section cue (chat = generative = drafts tone).
 */
import { MessageSquare } from 'lucide-react';
import { Panel } from '@/components/dashboard/Panel';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <div
      data-testid="chat-page"
      className="stagger"
      style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 760 }}
    >
      <header>
        <h1 className="h-page" style={{ marginBottom: 8 }}>
          Chat with KOS
        </h1>
        <p className="h-page-meta">
          Sonnet 4.6 · entity-graph context · ships with Phase 11-ter
        </p>
      </header>

      <Panel
        tone="drafts"
        name="Conversational surface"
        count="· coming soon"
        aria-label="Chat coming soon"
      >
        <div className="flex flex-col gap-4" style={{ maxWidth: 620 }}>
          <div className="flex items-start gap-[14px]">
            <span
              aria-hidden
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                display: 'grid',
                placeItems: 'center',
                background:
                  'color-mix(in srgb, var(--color-sect-drafts) 10%, transparent)',
                border:
                  '1px solid color-mix(in srgb, var(--color-sect-drafts) 26%, transparent)',
                color: 'var(--color-sect-drafts)',
                flexShrink: 0,
              }}
            >
              <MessageSquare size={16} strokeWidth={1.7} />
            </span>
            <div className="flex flex-col gap-3">
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--color-text)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                The persistent chat bubble bottom-right opens a quick
                drawer for ad-hoc questions. The full chat interface
                ships with Phase 11-ter — Sonnet 4.6 with entity-graph
                context and a tool-use surface for searching and writing
                across your KOS data.
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-3)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                Until then this page is a stub. Use the bubble for
                visual validation, or Telegram for live conversational
                capture.
              </p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
