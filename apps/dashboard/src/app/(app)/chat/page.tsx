/**
 * /chat — Chat with KOS (Phase 11 Plan 11-02).
 *
 * Streaming AI chat interface wired to kos-chat Lambda via /api/chat proxy.
 * Loads chat history from localStorage (per-session), streams answers with
 * markdown rendering, links entities to /entities/[id] when mentioned.
 *
 * Layout: full-height chat thread with input at bottom. Uses Panel wrapper
 * for consistency with other views. Uses shadcn <Sheet /> for mobile.
 */

'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Send, AlertCircle, Loader2 } from 'lucide-react';
import { Panel } from '@/components/dashboard/Panel';
import { ChatInput } from './ChatInput';
import { ChatThread } from './ChatThread';
import type { ChatMessage } from './types';

const STORAGE_KEY = 'kos-chat-session';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Load session from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const { sessionId: sid, messages: msgs } = JSON.parse(stored);
        setSessionId(sid);
        setMessages(msgs ?? []);
      } catch {
        // Corrupted — start fresh
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  // Auto-scroll to bottom when messages arrive
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;

    setError(null);
    const userMessage: ChatMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          sessionId: sessionId ?? undefined,
          history: newMessages.slice(0, -1), // exclude current user msg
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(err);
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

      // Persist to localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: data.sessionId, messages: updated }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Remove the user message on error
      setMessages(newMessages.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = () => {
    setMessages([]);
    setSessionId(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleEntityClick = (entityId: string) => {
    router.push(`/entities/${entityId}`);
  };

  return (
    <div
      data-testid="chat-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        maxWidth: 840,
        height: '100%',
      }}
    >
      <header>
        <h1 className="h-page" style={{ marginBottom: 8 }}>
          Chat with KOS
        </h1>
        <p className="h-page-meta">Sonnet 4.6 · entity-graph context · tool-use enabled</p>
      </header>

      <Panel
        tone="drafts"
        name="Conversation"
        count={messages.length > 0 ? `· ${Math.ceil(messages.length / 2)} turns` : undefined}
        bodyPadding="flush"
        aria-label="Chat thread"
      >
        <div
          ref={threadRef}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            height: 'clamp(200px, 60vh, 600px)',
            overflowY: 'auto',
            padding: '20px 20px',
          }}
          role="log"
          aria-live="polite"
        >
          {messages.length === 0 && !error ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--color-text-3)',
                fontSize: 'var(--text-body)',
                textAlign: 'center',
              }}
            >
              <p>Start a conversation. Ask about your entities, tasks, or what's on your plate.</p>
            </div>
          ) : (
            <>
              <ChatThread
                messages={messages}
                onEntityClick={handleEntityClick}
              />
              {loading && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--color-text-3)',
                    fontSize: 'var(--text-body)',
                  }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  <span>Thinking…</span>
                </div>
              )}
            </>
          )}
          {error && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 14px',
                background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-danger) 28%, transparent)',
                borderRadius: 8,
                color: 'var(--color-text)',
                fontSize: 'var(--text-sm)',
              }}
              role="alert"
            >
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-danger)' }} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </Panel>

      <ChatInput
        onSendMessage={handleSendMessage}
        disabled={loading}
        onClear={messages.length > 0 ? handleClearHistory : undefined}
      />
    </div>
  );
}
