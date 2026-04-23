/**
 * Stub page for Entity detail — real body lands in Plan 03-08 (dossier).
 */
import { PulseDot } from '@/components/system/PulseDot';

export default async function EntityDetailStub({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
        Entity
      </h1>
      <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-text-3)]">
        <PulseDot tone="accent" />
        <span className="font-mono">{id}</span>
        <span>— dossier ships with Plan 03-08.</span>
      </p>
    </div>
  );
}
