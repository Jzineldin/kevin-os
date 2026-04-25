import { describe, it, expect } from 'vitest';
import { getBolagClass, getBolagToken, BOLAG_MAP } from '@/lib/bolag';

describe('getBolagClass', () => {
  it('maps "Tale Forge" to bolag-tf (case insensitive, space variant)', () => {
    expect(getBolagClass('Tale Forge')).toBe('bolag-tf');
    expect(getBolagClass('TALE FORGE')).toBe('bolag-tf');
    expect(getBolagClass('tale-forge')).toBe('bolag-tf');
  });

  it('maps "Outbehaving" to bolag-ob', () => {
    expect(getBolagClass('Outbehaving')).toBe('bolag-ob');
    expect(getBolagClass('outbehaving')).toBe('bolag-ob');
  });

  it('maps "Personal" explicitly to bolag-pe', () => {
    expect(getBolagClass('Personal')).toBe('bolag-pe');
    expect(getBolagClass('personal')).toBe('bolag-pe');
  });

  it('returns bolag-pe fallback for null, undefined, and empty', () => {
    expect(getBolagClass(null)).toBe('bolag-pe');
    expect(getBolagClass(undefined)).toBe('bolag-pe');
    expect(getBolagClass('')).toBe('bolag-pe');
    expect(getBolagClass('   ')).toBe('bolag-pe');
  });

  it('returns bolag-pe fallback for unknown org strings', () => {
    expect(getBolagClass('Stripe')).toBe('bolag-pe');
    expect(getBolagClass('Some Unknown Co')).toBe('bolag-pe');
  });

  it('exposes BOLAG_MAP as a frozen-shape lookup', () => {
    // Values are always one of the three expected classes.
    const values = Object.values(BOLAG_MAP);
    for (const v of values) {
      expect(['bolag-tf', 'bolag-ob', 'bolag-pe']).toContain(v);
    }
  });
});

describe('getBolagToken', () => {
  it('returns the canonical token name matching --color-<token>', () => {
    expect(getBolagToken('Tale Forge')).toBe('tale-forge');
    expect(getBolagToken('Outbehaving')).toBe('outbehaving');
    expect(getBolagToken('Personal')).toBe('personal');
    expect(getBolagToken(null)).toBe('personal');
    expect(getBolagToken('Unknown')).toBe('personal');
  });
});
