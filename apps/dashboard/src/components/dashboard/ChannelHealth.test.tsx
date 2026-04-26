import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChannelHealth } from './ChannelHealth';

describe('ChannelHealth', () => {
  it('renders a channel card with the channel name', () => {
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
    // Status is conveyed via the `.mc-channel-bar` wrapper's data
    // attribute + color dot; there is no literal "healthy" string.
    const bar = document.querySelector(
      '[data-testid="mc-channel-bar"][data-channel="Telegram"]',
    );
    expect(bar).toBeTruthy();
  });

  it('renders the 6 default channel topology when the payload is empty', () => {
    // Empty payload → <ChannelHealth /> surfaces the full integration
    // topology in a 'down' state so Kevin can see exactly which capture
    // surfaces are silent (D-30, Plan 11-04 Task 1).
    render(<ChannelHealth channels={[]} />);
    const bars = document.querySelectorAll(
      '[data-testid="mc-channel-bar"]',
    );
    expect(bars.length).toBe(6);
  });
});
