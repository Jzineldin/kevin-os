import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { StatTile } from './StatTile';

describe('StatTile (v4)', () => {
  it('renders label in caps and value', () => {
    render(<StatTile icon={Inbox} label="DRAFTS PENDING" value={42} />);
    expect(screen.getByText('DRAFTS PENDING')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders 0 when value is zero', () => {
    render(<StatTile icon={Inbox} label="EMPTY" value={0} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('carries the tone data attribute for section wiring', () => {
    const { container } = render(
      <StatTile icon={Inbox} label="X" value={1} tone="drafts" />,
    );
    const tile = container.querySelector('.kpi');
    expect(tile).toBeTruthy();
    expect(tile?.getAttribute('data-tone')).toBe('drafts');
  });

  it('renders optional delta text', () => {
    render(
      <StatTile icon={Inbox} label="X" value={3} delta="1 due today" />,
    );
    expect(screen.getByText('1 due today')).toBeTruthy();
  });
});
