import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChannelHealth } from './ChannelHealth';

describe('ChannelHealth', () => {
  it('renders channels with name + status', () => {
    render(
      <ChannelHealth
        channels={[
          {
            name: 'Telegram',
            type: 'capture',
            status: 'healthy',
            last_event_at: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(screen.getByText('Telegram')).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
  });

  it('renders empty state for no channels', () => {
    render(<ChannelHealth channels={[]} />);
    expect(screen.getByText(/No channels configured/i)).toBeTruthy();
  });
});
