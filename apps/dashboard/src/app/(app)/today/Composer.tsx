'use client';

/**
 * Composer — v4 Capture panel sitting in the right column of /today.
 *
 * Visual reference: mockup-v4.html § Capture panel
 *
 * Compact panel with:
 *   - Textarea that snaps to surface-0 (bg) when unfocused and uses
 *     sect-priority as its focus ring color.
 *   - Foot row: "auto-detects" hint on the left, mono ⌘↵ on the right,
 *     primary sm-sized "Capture" submit button.
 *   - PulseDot preserved in the panel header count slot as the
 *     capture-ack signal (accent → warning while awaiting SSE ack →
 *     success on match). Moves out of the body so the composer stays
 *     uncluttered.
 *
 * Behavior unchanged from Phase 3: POST via captureText action, waits
 * 5s for `capture_ack` SSE with matching id, toasts on success/failure.
 */
import { useCallback, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { PulseDot, type PulseTone } from '@/components/system/PulseDot';
import { Panel } from '@/components/dashboard/Panel';
import { useSseKind } from '@/components/system/SseProvider';
import type { SseEvent } from '@kos/contracts/dashboard';

import { captureText } from './actions';

const PLACEHOLDER = 'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.';
const SUBMIT_LABEL = 'Skicka';
const RETRY_ERROR = "Capture didn't reach KOS. Retry?";
const ACK_WAIT_MS = 5_000;

export function Composer() {
  const [text, setText] = useState('');
  const [pending, startTransition] = useTransition();
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const [dotTone, setDotTone] = useState<PulseTone>('accent');
  const ackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onAck = useCallback(
    (ev: SseEvent) => {
      if (ev.id === waitingFor) {
        setDotTone('success');
        setWaitingFor(null);
        if (ackTimeoutRef.current) {
          clearTimeout(ackTimeoutRef.current);
          ackTimeoutRef.current = null;
        }
      }
    },
    [waitingFor],
  );
  useSseKind('capture_ack', onAck as never);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const payload = text.trim();
    if (!payload) return;
    setText('');
    setDotTone('warning');
    startTransition(async () => {
      try {
        const res = await captureText(payload);
        setWaitingFor(res.capture_id);
        toast.success(`Captured ${res.capture_id}`, { duration: 3_000 });
        if (ackTimeoutRef.current) clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = setTimeout(() => {
          setDotTone('warning');
        }, ACK_WAIT_MS);
      } catch {
        toast.error(RETRY_ERROR, {
          duration: Infinity,
          action: { label: 'Retry', onClick: () => setText(payload) },
        });
        setDotTone('accent');
      }
    });
  }

  return (
    <Panel
      tone="priority"
      name="Capture"
      count={
        <span className="flex items-center gap-2">
          <PulseDot tone={dotTone} />
          <span className="mono">⌘ ↵</span>
        </span>
      }
      bodyPadding="tight"
      aria-label="Quick capture"
      testId="today-composer"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-[10px]">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="Capture input"
          rows={3}
          disabled={pending}
          className="bg-[color:var(--color-bg)] min-h-[64px] border-[color:var(--color-border)] focus-visible:border-[color:var(--color-sect-priority)]"
        />
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.04em] text-[color:var(--color-text-4)]">
            auto-detects entity
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !text.trim()}
            data-testid="today-composer-send"
          >
            {SUBMIT_LABEL}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
