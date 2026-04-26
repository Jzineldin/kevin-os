/**
 * ChannelHealth — bordered list of capture / scheduler channels with status
 * pill (healthy / degraded / down) and last-event relative timestamp.
 *
 * Visual reference: 11-RESEARCH.md "Visual Pattern Reference" — channel-health
 * block (Telegram, Gmail, Granola, Calendar, LinkedIn, Chrome).
 * Analog: today/DraftsCard.tsx (sectioned list with header + rows).
 *
 * Each row deep-links to /integrations-health (Plan 11-04 ships the page).
 *
 * Type imported from `@kos/contracts` so this component is the canonical
 * consumer — Plans 11-04 + 11-06 import the same `ChannelHealthItem` type
 * from contracts (no redefinition).
 */
import { Activity } from 'lucide-react';
import Link from 'next/link';
import type { ChannelHealthItem } from '@kos/contracts/dashboard';

export type { ChannelHealthItem };

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function statusToTone(
  status: ChannelHealthItem['status'],
): 'success' | 'warning' | 'danger' {
  if (status === 'healthy') return 'success';
  if (status === 'degraded') return 'warning';
  return 'danger';
}

function statusToBg(status: ChannelHealthItem['status']): string {
  if (status === 'healthy')
    return 'color-mix(in srgb, var(--color-success) 15%, transparent)';
  if (status === 'degraded')
    return 'color-mix(in srgb, var(--color-warning) 15%, transparent)';
  return 'color-mix(in srgb, var(--color-danger) 15%, transparent)';
}

function statusToFg(status: ChannelHealthItem['status']): string {
  if (status === 'healthy') return 'var(--color-success)';
  if (status === 'degraded') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

export function ChannelHealth({
  channels,
}: {
  channels: ChannelHealthItem[];
}) {
  if (channels.length === 0) {
    return (
      <div
        className="mc-channel-empty"
        style={{ color: 'var(--color-text-3)', fontSize: 12, padding: 8 }}
      >
        No channels configured
      </div>
    );
  }
  return (
    <div className="mc-channel-list">
      {channels.map((ch) => (
        <Link
          key={ch.name}
          href="/integrations-health"
          className="mc-channel-bar"
          data-channel={ch.name}
          data-testid="mc-channel-bar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 4px',
            borderBottom: '1px solid var(--color-border)',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              flex: 1,
            }}
          >
            <Activity
              size={14}
              style={{ color: 'var(--color-text-3)' }}
              aria-hidden
            />
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--color-text)',
                  margin: 0,
                }}
              >
                {ch.name}
              </p>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-3)',
                  margin: 0,
                }}
              >
                {timeAgo(ch.last_event_at)}
              </p>
            </div>
          </div>
          <span
            className="mc-pill"
            data-tone={statusToTone(ch.status)}
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: '2px 8px',
              borderRadius: 999,
              color: statusToFg(ch.status),
              background: statusToBg(ch.status),
            }}
          >
            {ch.status}
          </span>
        </Link>
      ))}
    </div>
  );
}
