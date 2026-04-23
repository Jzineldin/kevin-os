/**
 * Bolag (company) → Tailwind badge-class mapping.
 *
 * Per 03-UI-SPEC.md §"Bolag (Company) Color Mapping — Binding Rules" every
 * entity carries an `org` (or `bolag` on projects) field. The three allowed
 * values map to three Tailwind classes declared in globals.css:
 *
 *   bolag-tf → --color-tale-forge (sky-400)   — Tale Forge AB
 *   bolag-ob → --color-outbehaving (orange-400) — Outbehaving (side-project CTO)
 *   bolag-pe → --color-personal   (violet-400)  — Personal / unknown / null
 *
 * Unknown or missing values fall through to `bolag-pe` ("personal") — calm
 * purple that doesn't scream a brand colour. This is the explicit fallback
 * per CONTEXT D-09 (no third-party hex values in JSX — tokens only).
 */

export const BOLAG_MAP = {
  'tale forge': 'bolag-tf',
  'tale-forge': 'bolag-tf',
  outbehaving: 'bolag-ob',
  personal: 'bolag-pe',
} as const satisfies Record<string, 'bolag-tf' | 'bolag-ob' | 'bolag-pe'>;

export type BolagClass = 'bolag-tf' | 'bolag-ob' | 'bolag-pe';
export type BolagToken = 'tale-forge' | 'outbehaving' | 'personal';

/**
 * Returns the Tailwind badge class for a given org/bolag string.
 *
 * Case-insensitive, accepts hyphenated + spaced variants. Null, undefined,
 * empty string, or unknown value → `bolag-pe` fallback.
 */
export function getBolagClass(org: string | null | undefined): BolagClass {
  if (!org) return 'bolag-pe';
  const key = org.trim().toLowerCase();
  if (!key) return 'bolag-pe';
  const mapped = (BOLAG_MAP as Record<string, BolagClass>)[key];
  return mapped ?? 'bolag-pe';
}

/**
 * Returns the canonical token name (matches --color-<token> in globals.css).
 */
export function getBolagToken(org: string | null | undefined): BolagToken {
  const cls = getBolagClass(org);
  switch (cls) {
    case 'bolag-tf':
      return 'tale-forge';
    case 'bolag-ob':
      return 'outbehaving';
    case 'bolag-pe':
    default:
      return 'personal';
  }
}
