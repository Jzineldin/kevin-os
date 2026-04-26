/**
 * /chat — Phase 11 Plan 11-07 visual-only shell.
 *
 * The persistent ChatBubble (mounted globally in (app)/layout.tsx) opens
 * a quick drawer for ad-hoc questions. This page is the deep-link
 * counterpart: a placeholder until Phase 11-ter wires the conversational
 * backend (Sonnet 4.6 + entity-graph context + tool-use surface).
 *
 * No SSE, no client interactivity — pure RSC shell with informative copy
 * per D-12 (calm empty states).
 */
export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <div
      data-testid="chat-page"
      className="fade-up"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <header>
        <h1
          className="h-page"
          style={{ marginBottom: 6 }}
        >
          Chat with KOS
        </h1>
        <p
          className="h-page-meta mono"
          style={{ margin: 0 }}
        >
          Sonnet 4.6 · entity-graph context · ships with Phase 11-ter
        </p>
      </header>

      <section
        style={{
          padding: 24,
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          background: 'var(--color-surface-1)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxWidth: 720,
        }}
      >
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-text-2)',
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          The persistent chat bubble bottom-right opens a quick drawer for
          ad-hoc questions. The full chat interface ships with Phase
          11-ter — Sonnet 4.6 + entity-graph context + tool-use surface
          for searching and writing across your KOS data.
        </p>
        <p
          style={{
            fontSize: 12,
            color: 'var(--color-text-3)',
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Until then, this page is a stub. Use the bubble for visual
          validation and Telegram for live conversational capture.
        </p>
      </section>
    </div>
  );
}
