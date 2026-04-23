/**
 * Stub page for Settings — wiring lands in a later phase.
 */
import { PulseDot } from '@/components/system/PulseDot';

export default function SettingsStub() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
        Settings
      </h1>
      <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-text-3)]">
        <PulseDot tone="accent" />
        <span>Settings stub — not wired in Phase 3.</span>
      </p>
    </div>
  );
}
