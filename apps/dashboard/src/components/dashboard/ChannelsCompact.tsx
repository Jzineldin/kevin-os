/**
 * ChannelsCompact — v4 right-column channel-health pill list.
 *
 * Visual reference: mockup-v4.html § Channels panel (compact tile).
 *
 * Dense vertical list (9px gap) showing at a glance which capture
 * surfaces are healthy vs degraded vs down. Each row links to
 * /integrations-health. The existing <ChannelHealth /> card-grid
 * stays in place for the Integrations Health route (Phase 5) — this
 * compact variant lives in the right rail of /today.
 */
import Link from 'next/link';
import type { ChannelHealthItem } from '@kos/contracts/dashboard';
import { Panel } from '@/components/dashboard/Panel';
import { formatDistanceToNow } from 'date-fns';

const DEFAULTS: ChannelHealthItem[] = [
  { name: 'Telegram', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Gmail', type: 'capture', status: 'down', last_event_at: null },
  { name: 'Granola', type: 'capture', status: 'down', last_event_at: null },
  {
    name: 'Google Calendar',
    type: 'capture',
    status: 'down',
    last_event_at: null,
  },
  {
    name: 'Chrome extension',
    type: 'capture',
    status: 'down',
    last_event_at: null,
  },
  { name: 'LinkedIn', type: 'capture', status: 'down', last_event_at: null },
];

function statusTone(
  status: ChannelHealthItem['status'],
): 'ok' | 'warn' | 'err' {
  if (status === 'healthy') return 'ok';
  if (status === 'degraded') return 'warn';
  return 'err';
}

function freshness(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: false });
  } catch {
    return '—';
  }
}

/**
 * Row label. Phase 11 D-07 correction: don't call it "reauth" unless we
 * actually know the token is invalid — we don't have that signal. A channel
 * is "down" when it has no recent events, which could also mean "idle" or
 * "not wired yet". Show the real freshness when we have one; only fall back
 * to a status word when we have no event timestamp at all.
 */
function rowLabel(ch: ChannelHealthItem): string {
  if (ch.last_event_at) {
    const age = freshness(ch.last_event_at);
    return ch.status === 'healthy' ? age : `${age} old`;
  }
  return ch.status === 'down' ? 'offline' : '—';
}

export function ChannelsCompact({
  channels,
}: {
  channels: ChannelHealthItem[];
}) {
  const list = channels.length === 0 ? DEFAULTS : channels;
  const lastEvent = list
    .map((c) => c.last_event_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .reverse()[0];

  return (
    <Panel
      tone="channels"
      name="Channels"
      count={
        lastEvent ? `· synced ${freshness(lastEvent)} ago` : '· awaiting sync'
      }
      bodyPadding="tight"
      aria-label="Channel health"
      testId="channels-compact"
    >
      <Link href="/integrations-health" className="block no-underline">
        <div className="ch-list">
          {list.map((ch) => {
            const tone = statusTone(ch.status);
            return (
              <div
                key={ch.name}
                className={`ch-row-compact ${tone}`}
                data-channel={ch.name}
                data-testid="channel-compact-row"
              >
                <span className="d" aria-hidden />
                <span className="nm">{ch.name}</span>
                <span className="n">{rowLabel(ch)}</span>
              </div>
            );
          })}
        </div>
      </Link>
    </Panel>
  );
}
