'use client';

/**
 * ChatSheet — quick-access chat drawer that opens from the floating ChatBubble.
 *
 * Wired to kos-chat backend (Phase 11-01) via the Vercel /api/chat proxy.
 * Persistence is per-session stored in localStorage.
 * Users can click "Go to full chat" to open /chat for a larger interface.
 */
import { useState, useRef, useEffect } from 'react';
import { ChevronRight, Send, Loader2, AlertCircle } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { ChatMessage } from '@/app/(app)/chat/types';

const SHEET_STORAGE_KEY = 'kos-chat-sheet-session';

interface ChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatSheet({ open, onOpenChange }: ChatSheetProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Load session on mount / open
  useEffect(() => {
    if (!open) return;
    const stored = localStorage.getItem(SHEET_STORAGE_KEY);
    if (stored) {
      try {
        const { sessionId: sid, messages: msgs } = JSON.parse(stored);
        setSessionId(sid);
        setMessages(msgs ?? []);
      } catch {
        localStorage.removeItem(SHEET_STORAGE_KEY);
      }
    }
  }, [open]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    setError(null);
    const userMessage: ChatMessage = { role: 'user', content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: input,
          sessionId: sessionId ?? undefined,
          history: newMessages.slice(0, -1),
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        answer: string;
        sessionId: string;
        citations?: Array<{ entity_id: string; name: string }>;
      };

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: data.answer,
        citations: data.citations,
      };
      const updated = [...newMessages, assistantMessage];
      setMessages(updated);
      setSessionId(data.sessionId);

      localStorage.setItem(SHEET_STORAGE_KEY, JSON.stringify({ sessionId: data.sessionId, messages: updated }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages(newMessages.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] sm:w-[480px] flex flex-col"
        data-testid="chat-sheet"
      >
        <SheetHeader>
          <SheetTitle>Chat with KOS</SheetTitle>
          <SheetDescription>
            Sonnet 4.6 · entity-graph context · tool-use enabled
          </SheetDescription>
        </SheetHeader>

        {/* Thread */}
        <div
          ref={threadRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '16px 0',
            minHeight: 200,
          }}
          role="log"
          aria-live="polite"
        >
          {messages.length === 0 && !error ? (
            <p
              style={{
                fontSize: 13,
                color: 'var(--color-text-3)',
                lineHeight: 1.5,
              }}
            >
              Ask a quick question. Full chat history available on the <strong>/chat</strong> page.
            </p>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    color:
                      msg.role === 'user'
                        ? 'var(--color-text-3)'
                        : 'var(--color-sect-drafts)',
                  }}
                >
                  {msg.role === 'user' ? 'You' : 'KOS'}
                </span>
                <p
                  style={{
                    margin: 0,
                    color: 'var(--color-text)',
                    lineHeight: 1.5,
                  }}
                >
                  {msg.content}
                </p>
              </div>
            ))
          )}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-3)' }}>
              <Loader2 size={12} className="animate-spin" />
              <span style={{ fontSize: 13 }}>Thinking…</span>
            </div>
          )}
          {error && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '10px 12px',
                background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-danger) 28%, transparent)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--color-text)',
              }}
              role="alert"
            >
              <AlertCircle size={14} style={{ flexShrink: 0, color: 'var(--color-danger)' }} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Input */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            paddingTop: 12,
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !loading) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask something…"
            disabled={loading}
            style={{
              flex: 1,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface-1)',
              color: 'var(--color-text)',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            type="button"
            style={{
              width: 32,
              height: 32,
              padding: 0,
              borderRadius: 6,
              border: 'none',
              background: !input.trim() || loading ? 'var(--color-surface-2)' : 'var(--color-sect-drafts)',
              color: 'white',
              cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !input.trim() || loading ? 0.5 : 1,
            }}
          >
            <Send size={14} />
          </button>
        </div>

        {/* Link to full chat */}
        {messages.length > 0 && (
          <div
            style={{
              paddingTop: 12,
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <a
              href="/chat"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--color-sect-drafts)',
                textDecoration: 'none',
              }}
            >
              Go to full chat
              <ChevronRight size={14} />
            </a>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
