/**
 * BrandMark — 22×22 accent-gradient square rendered in sidebar header and
 * the login card, per 03-UI-SPEC §Sidebar (#1 Brand) + §Login.
 *
 * Gradient matches TFOS-ui.html .brand-mark lines 78–84 verbatim via
 * `--color-accent`/`--color-accent-2` tokens.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <span
      aria-label="Kevin OS"
      data-slot="brand-mark"
      className="inline-block rounded-md"
      style={{
        width: size,
        height: size,
        background:
          'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))',
      }}
    />
  );
}
