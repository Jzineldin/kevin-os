/**
 * Typed registry of design-system tokens.
 *
 * Source of truth: apps/dashboard/src/app/globals.css @theme block (lines 8-70).
 * This file mirrors those values for TypeScript consumers (e.g. inline style
 * objects, runtime tone-to-class mapping, Storybook stories).
 *
 * RULE: NEVER add a color here that is not already in the @theme block.
 * Adding a new color requires updating globals.css first (locked 03-UI-SPEC).
 *
 * Plan 11-02 — Wave 1 mission-control primitives.
 */

export const COLORS = {
  bg: 'var(--color-bg)',
  surface1: 'var(--color-surface-1)',
  surface2: 'var(--color-surface-2)',
  surface3: 'var(--color-surface-3)',
  surfaceHover: 'var(--color-surface-hover)',
  border: 'var(--color-border)',
  text: 'var(--color-text)',
  text3: 'var(--color-text-3)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
} as const;

export type ColorKey = keyof typeof COLORS;

/** Tonal vocabulary for Pill, ChannelHealth, StatTile components. */
export const TONES = {
  accent: {
    fg: COLORS.accent,
    bg: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
  },
  success: {
    fg: COLORS.success,
    bg: 'color-mix(in srgb, var(--color-success) 15%, transparent)',
  },
  warning: {
    fg: COLORS.warning,
    bg: 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
  },
  danger: {
    fg: COLORS.danger,
    bg: 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
  },
  info: {
    fg: COLORS.info,
    bg: 'color-mix(in srgb, var(--color-info) 15%, transparent)',
  },
  neutral: { fg: COLORS.text3, bg: COLORS.surface2 },
  dim: { fg: COLORS.text3, bg: 'transparent' },
} as const;

export type Tone = keyof typeof TONES;

/** Spacing scale — mirror @theme spacing tokens if you add any. */
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
} as const;

export type SpacingKey = keyof typeof SPACING;
