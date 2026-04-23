/**
 * Stub page for Today — real body lands in Plan 03-07/08 (SSE-driven
 * morning brief + priority list). This stub exists so the (app) layout
 * has a landing route for the `T` keyboard shortcut + middleware smoke.
 */
import { PulseDot } from '@/components/system/PulseDot';

export default function TodayStub() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
        Today
      </h1>
      <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-text-3)]">
        <PulseDot tone="accent" />
        <span>View body ships with Plan 03-07 (SSE) + 03-08 (Today).</span>
      </p>
    </div>
  );
}
