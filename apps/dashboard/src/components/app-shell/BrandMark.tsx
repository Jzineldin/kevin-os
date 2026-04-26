/**
 * BrandMark — v4 Kevin OS logo square. 28×28 by default, rounded.
 *
 * v4 visual:
 *   - Base: 135° gradient from sect-priority → darker navy (#2e5bb0)
 *   - Inner inset 6px with a light-gloss highlight in the top-left to
 *     give it physicality without glassmorphism
 *   - Subtle inset border so it reads against surface-1
 *
 * Used by Sidebar header (28px) and Login card (32px).
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-label="Kevin OS"
      data-slot="brand-mark"
      className="relative inline-block rounded-lg"
      style={{
        width: size,
        height: size,
        background:
          'linear-gradient(135deg, var(--color-sect-priority), #2e5bb0)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    >
      <span
        aria-hidden
        className="absolute rounded-[3px]"
        style={{
          top: size > 24 ? 6 : 4,
          right: size > 24 ? 6 : 4,
          bottom: size > 24 ? 6 : 4,
          left: size > 24 ? 6 : 4,
          background:
            'linear-gradient(135deg, rgba(255,255,255,0.2), transparent 70%)',
        }}
      />
    </span>
  );
}
