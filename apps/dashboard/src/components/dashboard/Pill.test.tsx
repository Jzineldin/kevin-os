import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Pill } from './Pill';

describe('Pill', () => {
  it('renders URGENT — Draft ready with danger tone', () => {
    render(<Pill classification="urgent" status="draft" />);
    const el = screen.getByText(/URGENT — Draft ready/);
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-tone')).toBe('danger');
  });

  it('renders Important with info tone', () => {
    render(<Pill classification="important" status="sent" />);
    const el = screen.getByText('Important');
    expect(el.getAttribute('data-tone')).toBe('info');
  });

  it('renders Triaging with pulse for pending_triage', () => {
    render(<Pill classification={null} status="pending_triage" />);
    const el = screen.getByText(/Triaging/);
    expect(el.getAttribute('data-tone')).toBe('accent');
    expect(el.getAttribute('data-pulse')).toBe('true');
  });

  it('renders Junk dimly when skipped', () => {
    render(<Pill classification="junk" status="skipped" />);
    const el = screen.getByText('Skipped');
    expect(el.getAttribute('data-tone')).toBe('dim');
  });
});
