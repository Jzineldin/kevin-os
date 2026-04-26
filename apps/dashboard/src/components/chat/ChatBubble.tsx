'use client';

/**
 * ChatBubble — floating bottom-right action button that opens the ChatSheet.
 *
 * Visual reference: 11-CONTEXT D-01 + 11-RESEARCH "persistent chat bubble".
 * Wave 3 (Plan 11-07) mounts <ChatBubble /> in (app)/layout.tsx so it stays
 * visible across every page. This plan only ships the component.
 *
 * Styled via the `.mc-chat-bubble` class (globals.css Phase 11 section).
 * `data-testid="chat-bubble"` exists so the Wave 3 button-audit harness can
 * locate it during the smoke pass.
 */
import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { ChatSheet } from './ChatSheet';

export function ChatBubble() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mc-chat-bubble"
        aria-label="Open chat"
        data-testid="chat-bubble"
      >
        <MessageSquare size={20} aria-hidden />
      </button>
      <ChatSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
