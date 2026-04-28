/**
 * ChatInput — text input + send button for the chat page.
 *
 * Features:
 *   - Cmd/Ctrl+Enter to send
 *   - Multi-line support (textarea grows with content)
 *   - Clear history button when messages exist
 *   - Loading state disables input
 */

'use client';

import { useRef, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';

export interface ChatInputProps {
  onSendMessage: (text: string) => void;
  disabled?: boolean;
  onClear?: () => void;
}

export function ChatInput({ onSendMessage, disabled, onClear }: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (text.trim() && !disabled) {
      onSendMessage(text);
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const t = e.target;
    setText(t.value);
    // Auto-grow textarea
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Ask about your entities, tasks, or what's on your plate… (Cmd+Enter to send)"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface-1)',
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            fontSize: 'var(--text-body)',
            lineHeight: 1.5,
            minHeight: 42,
            maxHeight: 200,
            resize: 'none',
            opacity: disabled ? 0.6 : 1,
            transition: 'border-color var(--transition-fast)',
          }}
          onFocus={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor = 'var(--color-border-hover)';
          }}
          onBlur={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor = 'var(--color-border)';
          }}
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || disabled}
          type="button"
          aria-label="Send message"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 42,
            height: 42,
            padding: 0,
            borderRadius: 8,
            border: 'none',
            background:
              !text.trim() || disabled
                ? 'color-mix(in srgb, var(--color-sect-drafts) 20%, transparent)'
                : 'var(--color-sect-drafts)',
            color: 'white',
            cursor: !text.trim() || disabled ? 'not-allowed' : 'pointer',
            transition: 'background var(--transition-fast)',
            opacity: !text.trim() || disabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (text.trim() && !disabled) {
              (e.currentTarget as HTMLButtonElement).style.background =
                'color-mix(in srgb, var(--color-sect-drafts) 110%, white)';
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-sect-drafts)';
          }}
        >
          <Send size={16} />
        </button>
      </div>
      {onClear && (
        <button
          onClick={onClear}
          type="button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text-3)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            transition: 'color var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-danger)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-3)';
          }}
        >
          <Trash2 size={14} />
          Clear history
        </button>
      )}
    </div>
  );
}
