'use client';

/**
 * CapturesList — v4 Inbox preview panel on the right rail of /today.
 *
 * Visual reference: mockup-v4.html § Inbox preview panel (.inbox-row).
 *
 * Shows the five most recent captures from all sources (email, mention,
 * event, inbox_index, telegram_queue — Wave 0 schema, no capture_text
 * or capture_voice), as a dense list with:
 *
 *   [ 48px time ] [ 1fr title ] [ auto channel tag ]
 *
 * Unread rows (items from the last hour by default, fallback to all
 * when fewer than 3 exist) render with text-1 + semibold title; older
 * rows use text-2. This differs from Phase 11 CapturesList, which was
 * a full-width bottom-of-page block — v4 demotes it to a right-column
 * preview so the main reading column stays focused on brief/priorities/
 * drafts. The full inbox lives at /inbox (link in the panel action).
 */
import Link from 'next/link';
import { format, parseISO, differenceInMinutes } from 'date-fns';

import type { TodayCaptureItem } from '@kos/contracts/dashboard';
import { Panel } from '@/components/dashboard/Panel';

const SOURCE_LABEL: Record<TodayCaptureItem['source'], string> = {
  email: 'Email',
  mention: 'Mention',
  event: 'Event',
  inbox: 'Inbox',
  telegram_queue: 'Telegram',
};

const UNREAD_WINDOW_MIN = 60;

function hhmm(iso: string): string {
  try {
    return format(parseISO(iso), 'HH:mm');
  } catch {
    return '--:--';
  }
}

function isUnread(iso: string): boolean {
  try {
    return differenceInMinutes(new Date(), parseISO(iso)) <= UNREAD_WINDOW_MIN;
  } catch {
    return false;
  }
}

export function CapturesList({ captures }: { captures: TodayCaptureItem[] }) {
  const top = captures.slice(0, 5);
  const totalUnread = captures.filter((c) => isUnread(c.at)).length;

  return (
    <Panel
      tone="inbox"
      name="Inbox"
      count={
        captures.length > 0
          ? `· ${totalUnread > 0 ? `${totalUnread} new` : `${captures.length} today`}`
          : undefined
      }
      action={
        captures.length > 5 ? (
          <Link href="/inbox" className="panel-action">
            Open
          </Link>
        ) : undefined
      }
      bodyPadding="tight"
      aria-label="Inbox preview"
      testId="captures-list"
    >
      {top.length === 0 ? (
        <p className="text-[12px] text-[color:var(--color-text-3)]">
          No captures today — KOS will surface them as they arrive.
        </p>
      ) : (
        <div>
          {top.map((cap) => (
            <div
              key={`${cap.source}:${cap.id}`}
              className={`inbox-row ${isUnread(cap.at) ? 'unread' : ''}`}
              data-testid="capture-row"
              data-source={cap.source}
            >
              <span className="inbox-when">{hhmm(cap.at)}</span>
              <span className="inbox-title truncate">{cap.title}</span>
              <span className="inbox-ch">{SOURCE_LABEL[cap.source]}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
