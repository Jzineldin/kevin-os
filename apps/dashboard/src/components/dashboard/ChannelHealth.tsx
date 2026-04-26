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
import {
  Activity,
  Send,
  Mail,
  Mic,
  Calendar as CalendarIcon,
  Briefcase,
  Globe,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import Link from 'next/link';
import type { ChannelHealthItem } from '@kos/contracts/dashboard';

export type { ChannelHealthItem };

const CHANNEL_ICONS: Record<
  string,
  ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
> = {
  Telegram: Send,
  Gmail: Mail,
  Granola: Mic,
  Calendar: CalendarIcon,
  LinkedIn: Briefcase,
  Chrome: Globe,
};

const DEFAULT_CHANNELS: ChannelHealthItem[] = [
  { name: 'Telegram', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Gmail', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Granola', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Calendar', type: 'capture', status: 'down', last_event_at: null },
  { name: 'LinkedIn', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Chrome', type: 'capture', status: 'down', last_event_at: null },
];

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
  // When API returns empty, render the 6 expected channels in 'down' state so
  // the integration block always shows the operational topology — Kevin sees
  // exactly which integrations are present and which are silent.
  const list = channels.length === 0 ? DEFAULT_CHANNELS : channels;
  return (
    <div
      className="mc-channel-list"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 10,
      }}
    >
      {list.map((ch) => {
        const Icon = CHANNEL_ICONS[ch.name] ?? Activity;
        const fg = statusToFg(ch.status);
        const bg = statusToBg(ch.status);
        return (
          <Link
            key={ch.name}
            href="/integrations-health"
            className="mc-channel-bar"
            data-channel={ch.name}
            data-testid="mc-channel-bar"
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px 12px 16px',
              borderRadius: 12,
              border: '1px solid var(--color-border)',
              background: `linear-gradient(180deg, color-mix(in srgb, ${fg} 5%, var(--color-surface-1)) 0%, var(--color-surface-1) 80%)`,
              textDecoration: 'none',
              color: 'inherit',
              overflow: 'hidden',
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: 3,
                background: fg,
                opacity: 0.85,
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 0,
                flex: 1,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: bg,
                  color: fg,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid color-mix(in srgb, ${fg} 25%, transparent)`,
                  flexShrink: 0,
                }}
              >
                <Icon size={14} />
              </span>
              <div style={{ minWidth: 0 }}>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--color-text)',
                    margin: 0,
                    letterSpacing: '-0.005em',
                  }}
                >
                  {ch.name}
                </p>
                <p
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-3)',
                    margin: '2px 0 0 0',
                    letterSpacing: '0.02em',
                  }}
                >
                  {timeAgo(ch.last_event_at)}
                </p>
              </div>
            </div>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: fg,
                boxShadow: `0 0 0 3px color-mix(in srgb, ${fg} 20%, transparent), 0 0 8px 0 color-mix(in srgb, ${fg} 50%, transparent)`,
                flexShrink: 0,
                marginLeft: 8,
              }}
            />
          </Link>
        );
      })}
    </div>
  );
}
