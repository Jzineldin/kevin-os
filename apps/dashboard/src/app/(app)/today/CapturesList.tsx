'use client';

/**
 * CapturesList — today's all-source capture feed for the bottom of /today.
 *
 * Each row shows source (icon + label), title, optional detail (truncated to
 * 120 chars per T-11-04-01 mitigation), and relative time. Sources cover the
 * five tables that hold actual capture artifacts in prod (Wave 0 schema
 * verification — `capture_text` and `capture_voice` DO NOT EXIST):
 *
 *   email          → Mail icon            (email_drafts)
 *   mention        → AtSign icon          (mention_events)
 *   event          → MessageSquare icon   (event_log)
 *   inbox          → MessageSquare icon   (inbox_index)
 *   telegram_queue → Mic icon             (telegram_inbox_queue)
 *
 * Empty state copy follows D-12: informative, not blank.
 */
import { Mail, MessageSquare, Mic, AtSign } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { TodayCaptureItem } from '@kos/contracts/dashboard';

type IconType = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const SOURCE_ICON: Record<TodayCaptureItem['source'], IconType> = {
  email: Mail,
  mention: AtSign,
  event: MessageSquare,
  inbox: MessageSquare,
  telegram_queue: Mic,
};

const SOURCE_LABEL: Record<TodayCaptureItem['source'], string> = {
  email: 'Email',
  mention: 'Mention',
  event: 'Event',
  inbox: 'Inbox',
  telegram_queue: 'Telegram',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function CapturesList({ captures }: { captures: TodayCaptureItem[] }) {
  if (captures.length === 0) {
    return (
      <section
        className="side-card"
        data-testid="captures-list-empty"
        aria-labelledby="captures-h"
      >
        <h2
          id="captures-h"
          style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}
        >
          Today&apos;s Captures
        </h2>
        <p style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
          No captures today — KOS will surface as they arrive.
        </p>
      </section>
    );
  }
  return (
    <section
      className="side-card"
      data-testid="captures-list"
      aria-labelledby="captures-h"
    >
      <h2
        id="captures-h"
        style={{
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        Today&apos;s Captures{' '}
        <span className="count-chip" aria-hidden>
          {captures.length}
        </span>
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {captures.map((cap) => {
          const Icon = SOURCE_ICON[cap.source];
          return (
            <div
              key={`${cap.source}:${cap.id}`}
              className="thread-row"
              data-testid="capture-row"
              data-source={cap.source}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto',
                gap: 10,
                alignItems: 'start',
              }}
            >
              <Icon
                size={14}
                style={{ color: 'var(--color-text-3)', marginTop: 2 }}
                aria-hidden
              />
              <div style={{ minWidth: 0 }}>
                <div
                  className="thread-title"
                  style={{ fontSize: 13, color: 'var(--color-text)' }}
                >
                  <span
                    style={{
                      color: 'var(--color-text-3)',
                      fontSize: 11,
                      marginRight: 6,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {SOURCE_LABEL[cap.source]}
                  </span>
                  {cap.title}
                </div>
                {cap.detail ? (
                  <div
                    className="thread-meta"
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-3)',
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cap.detail.slice(0, 120)}
                  </div>
                ) : null}
              </div>
              <span style={{ fontSize: 11, color: 'var(--color-text-3)' }}>
                {timeAgo(cap.at)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
