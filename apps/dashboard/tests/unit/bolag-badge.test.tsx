/**
 * BolagBadge unit tests — asserts the three org flavors, both variants,
 * and the fallback behaviour for null / unknown. Matches the Plan 03-08
 * Task 1 acceptance: ≥ 5 cases.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { BolagBadge } from '@/components/badge/BolagBadge';

describe('BolagBadge', () => {
  it('renders Tale Forge as short "TF" with bolag-tf class', () => {
    const { container, getByText } = render(<BolagBadge org="Tale Forge" />);
    expect(getByText('TF')).toBeInTheDocument();
    const el = container.querySelector('.badge');
    expect(el?.classList.contains('bolag-tf')).toBe(true);
  });

  it('renders Outbehaving as short "OB" with bolag-ob class', () => {
    const { container, getByText } = render(<BolagBadge org="Outbehaving" />);
    expect(getByText('OB')).toBeInTheDocument();
    expect(container.querySelector('.bolag-ob')).toBeTruthy();
  });

  it('renders Personal as short "PE" with bolag-pe class', () => {
    const { container, getByText } = render(<BolagBadge org="Personal" />);
    expect(getByText('PE')).toBeInTheDocument();
    expect(container.querySelector('.bolag-pe')).toBeTruthy();
  });

  it('null / undefined / unknown org fall through to bolag-pe', () => {
    const a = render(<BolagBadge org={null} />);
    expect(a.container.querySelector('.bolag-pe')).toBeTruthy();
    const b = render(<BolagBadge org={undefined} />);
    expect(b.container.querySelector('.bolag-pe')).toBeTruthy();
    const c = render(<BolagBadge org="Stripe" />);
    expect(c.container.querySelector('.bolag-pe')).toBeTruthy();
  });

  it('variant="full" renders the full company label', () => {
    const { getByText: tf } = render(<BolagBadge org="Tale Forge" variant="full" />);
    expect(tf('Tale Forge')).toBeInTheDocument();
    const { getByText: ob } = render(<BolagBadge org="Outbehaving" variant="full" />);
    expect(ob('Outbehaving')).toBeInTheDocument();
    const { getByText: pe } = render(<BolagBadge org={null} variant="full" />);
    expect(pe('Personal')).toBeInTheDocument();
  });

  it('accepts additional className alongside the generated bolag class', () => {
    const { container } = render(<BolagBadge org="Tale Forge" className="ml-2" />);
    const el = container.querySelector('.badge');
    expect(el?.classList.contains('ml-2')).toBe(true);
    expect(el?.classList.contains('bolag-tf')).toBe(true);
  });
});
