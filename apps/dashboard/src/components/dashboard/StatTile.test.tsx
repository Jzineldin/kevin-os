import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  it('renders label in caps and value', () => {
    render(<StatTile icon={Inbox} label="DRAFTS PENDING" value={42} />);
    expect(screen.getByText('DRAFTS PENDING')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders 0 when value is zero', () => {
    render(<StatTile icon={Inbox} label="EMPTY" value={0} />);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('uses tone prop', () => {
    const { container } = render(
      <StatTile icon={Inbox} label="X" value={1} tone="success" />,
    );
    const tile = container.querySelector('.mc-stat-tile');
    expect(tile).toBeTruthy();
  });
});
