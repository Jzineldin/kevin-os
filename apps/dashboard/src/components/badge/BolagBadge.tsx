/**
 * BolagBadge — bolag-tinted pill badge rendered from any `org` / `bolag`
 * string value. Uses `getBolagClass` (lib/bolag.ts) to map the incoming
 * string to one of three known Tailwind classes declared in globals.css
 * (`bolag-tf`, `bolag-ob`, `bolag-pe` — see 03-UI-SPEC §Bolag Color
 * Mapping).
 *
 * - `variant="short"` (default) → 2-letter label (TF / OB / PE)
 * - `variant="full"` → full company name (Tale Forge / Outbehaving / Personal)
 *
 * Null, empty, or unknown org strings fall through to the `bolag-pe`
 * personal tint — the same fallback applied by `getBolagClass`.
 */
import { getBolagClass, type BolagClass } from '@/lib/bolag';

const SHORT: Record<BolagClass, string> = {
  'bolag-tf': 'TF',
  'bolag-ob': 'OB',
  'bolag-pe': 'PE',
};

const FULL: Record<BolagClass, string> = {
  'bolag-tf': 'Tale Forge',
  'bolag-ob': 'Outbehaving',
  'bolag-pe': 'Personal',
};

export function BolagBadge({
  org,
  variant = 'short',
  className,
}: {
  org: string | null | undefined;
  variant?: 'short' | 'full';
  className?: string;
}) {
  const cls = getBolagClass(org);
  const label = variant === 'short' ? SHORT[cls] : FULL[cls];
  return (
    <span
      className={['badge', cls, className].filter(Boolean).join(' ')}
      data-bolag={cls}
    >
      {label}
    </span>
  );
}
