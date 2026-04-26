'use client';

/**
 * ChatSheet — visual-only drawer that opens from the floating ChatBubble.
 *
 * Phase 11-ter ships the AI backend (Sonnet 4.6 + loadContext()) wired to
 * services/kos-chat. This shell exists so Wave 2 plans can mount the bubble
 * without blocking on backend work — the surface is in place; the messages
 * panel below is intentionally placeholder copy.
 *
 * shadcn primitive analog: dialog.tsx — same {Root, Trigger, Content,
 * Header, Title, Description} shape, just side-anchored.
 */
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

export function ChatSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[400px] sm:w-[480px]"
        data-testid="chat-sheet"
      >
        <SheetHeader>
          <SheetTitle>Chat with KOS</SheetTitle>
          <SheetDescription>
            Conversational AI grounded in your entity graph + semantic memory.
          </SheetDescription>
        </SheetHeader>
        <div
          role="status"
          style={{
            marginTop: 24,
            fontSize: 13,
            color: 'var(--color-text-3)',
            lineHeight: 1.6,
          }}
        >
          Coming in Phase 11-ter — AI chat backend not yet wired. The bubble +
          drawer shell ships first so the visual surface is in place. The
          Sonnet 4.6 + loadContext() backend lives in services/kos-chat
          (separate phase).
        </div>
      </SheetContent>
    </Sheet>
  );
}
