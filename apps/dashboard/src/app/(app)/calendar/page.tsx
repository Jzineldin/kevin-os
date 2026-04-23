/**
 * Stub page for Calendar — real body lands in Plan 03-10 (week grid).
 */
import { PulseDot } from '@/components/system/PulseDot';

export default function CalendarStub() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
        Calendar
      </h1>
      <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-text-3)]">
        <PulseDot tone="accent" />
        <span>Week grid ships with Plan 03-10.</span>
      </p>
    </div>
  );
}
