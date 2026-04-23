/**
 * Stub page for Inbox — real body lands in Plan 03-09 (triage queue).
 */
import { PulseDot } from '@/components/system/PulseDot';

export default function InboxStub() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
        Inbox
      </h1>
      <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-text-3)]">
        <PulseDot tone="accent" />
        <span>Triage queue ships with Plan 03-09.</span>
      </p>
    </div>
  );
}
