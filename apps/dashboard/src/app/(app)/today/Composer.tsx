'use client';

/**
 * Composer — voice/text dump zone for capture. Per 03-UI-SPEC §Today and
 * §Copywriting:
 *   - Swedish placeholder (data-side language, D-41 pass-through)
 *   - Primary button "Skicka" (Swedish, data-side)
 *   - On submit: clear textarea, show fade-in sonner toast with mono
 *     capture_id, auto-dismiss 3s (UI-SPEC).
 *   - Single PulseDot next to button: accent idle, warning on pending /
 *     no-ack, success when SSE `capture_ack` with matching id arrives.
 *   - If no ack within 5s, dot stays warning (UI-SPEC).
 *   - On failure: sonner toast "Capture didn't reach KOS. Retry?" with
 *     retry action; auto-dismiss disabled (UI-SPEC copy table).
 */
import { useCallback, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { PulseDot, type PulseTone } from '@/components/system/PulseDot';
import { useSseKind } from '@/components/system/SseProvider';
import type { SseEvent } from '@kos/contracts/dashboard';

import { captureText } from './actions';

const PLACEHOLDER =
  'Dumpa allt — en tanke, en idé, ett möte. KOS sorterar.';
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
        toast.success(`Captured ${res.capture_id}`, {
          duration: 3_000,
        });
        if (ackTimeoutRef.current) clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = setTimeout(() => {
          setDotTone('warning');
        }, ACK_WAIT_MS);
      } catch {
        toast.error(RETRY_ERROR, {
          duration: Infinity,
          action: {
            label: 'Retry',
            onClick: () => setText(payload),
          },
        });
        setDotTone('accent');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="side-card">
      <div className="h-section">CAPTURE</div>
      <div className="flex flex-col gap-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="Capture input"
          rows={4}
          className="bg-[color:var(--color-surface-2)]"
          disabled={pending}
        />
        <div className="flex items-center justify-between">
          <PulseDot tone={dotTone} />
          <Button
            type="submit"
            size="sm"
            disabled={pending || !text.trim()}
            data-testid="today-composer-send"
          >
            {SUBMIT_LABEL}
          </Button>
        </div>
      </div>
    </form>
  );
}
