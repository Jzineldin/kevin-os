/**
 * CalendarWeekView — Plan 03-10 Task 3 + Phase 11 Plan 11-05 Task 2.
 *
 * Maps to UI-SPEC §View 4 + TFOS-ui.html §05. Renders a 7-column × hourly
 * grid for the current Stockholm week with both:
 *   - Notion Command Center deadlines (source: command_center_*)
 *   - Real Google Calendar meetings (source: google_calendar) from
 *     calendar_events_cache via the calendar-reader Lambda.
 *
 * Visual distinction (Plan 11-05 D-07):
 *   - Notion CC deadlines retain their bolag-tinted accent via the
 *     existing `.cal-event.tf|.ob|.pe` classes in globals.css.
 *   - Google meetings show a left-border accent in `var(--color-info)`
 *     (sky-blue) via inline style + `data-source="google_calendar"`.
 *   - Legend at the top of the grid maps colour → kind for first-time
 *     orientation. Tooltip on each Google event carries the account
 *     label so Kevin can disambiguate kevin-elzarka vs kevin-taleforge.
 *
 * Empty state (D-12): "No meetings or deadlines this week — your
 * calendar is clear." replaces the previous "Nothing scheduled" copy.
 *
 * Binding rules:
 *   - Today column: `border-top: 2px solid var(--color-accent)` via the
 *     `.today-col` modifier on both the header and the 7 cells beneath.
 *   - Event hover is THE sole sanctioned hover-transform in the app
 *     (UI-SPEC line 428). The `.cal-event` rule in globals.css owns it;
 *     no other selector may carry `transform: translateY(...)` on hover.
 *   - Month tab is disabled with Tooltip copy "Month view ships with Phase 8".
 *   - Click event with linked_entity_id routes to /entities/[id].
 *   - SSE timeline_event → re-fetch the week (router.refresh is cheap at
 *     single-user volume).
 */
'use client';

import type { CSSProperties } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CalendarEvent, CalendarWeekResponse } from '@kos/contracts/dashboard';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSseKind } from '@/components/system/SseProvider';
import { getBolagClass } from '@/lib/bolag';

const DAY_LABELS_SV = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// 08:00 through 20:00 (13 rows) — covers the working day without
// squeezing the grid vertically. Events before 08:00 pin to row 0 and
// after 20:00 extend off the bottom with clamped height.
const HOURS = Array.from({ length: 13 }, (_, i) => 8 + i);
const ROW_HEIGHT_PX = 48;

function startOfDayISO(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Compute the 7 day starts for the week containing `anchor`, Monday-first.
 */
function weekDays(anchor: Date): Date[] {
  const start = startOfDayISO(anchor);
  // JS Date: getDay 0 = Sunday, 1 = Monday, … 6 = Saturday. We want Mon=0.
  const dow = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function bolagModifier(cls: 'bolag-tf' | 'bolag-ob' | 'bolag-pe'): 'tf' | 'ob' | 'pe' {
  return cls === 'bolag-tf' ? 'tf' : cls === 'bolag-ob' ? 'ob' : 'pe';
}

function eventPosition(ev: CalendarEvent, day: Date): { top: number; height: number } | null {
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  if (!sameDay(start, day)) return null;
  const firstHour = HOURS[0] ?? 0;
  const lastHour = HOURS[HOURS.length - 1] ?? 23;
  const startHourFloat = start.getHours() + start.getMinutes() / 60;
  const endHourFloat = end.getHours() + end.getMinutes() / 60;
  const clampedStart = Math.max(firstHour, startHourFloat);
  const clampedEnd = Math.min(lastHour + 1, Math.max(endHourFloat, clampedStart + 0.25));
  const top = (clampedStart - firstHour) * ROW_HEIGHT_PX;
  const height = Math.max(22, (clampedEnd - clampedStart) * ROW_HEIGHT_PX);
  return { top, height };
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${fmt(s)}–${fmt(e)}`;
}

function EventBar({ ev, day }: { ev: CalendarEvent; day: Date }) {
  const pos = eventPosition(ev, day);
  if (!pos) return null;
  const bolagCls = getBolagClass(ev.bolag);
  const mod = bolagModifier(bolagCls);

  // Plan 11-05 Task 2: Google meetings get a sky-blue left-border accent
  // distinct from the bolag-tinted Notion CC deadlines. The bolag class
  // is still applied (default 'pe') so non-bolag tinting is consistent;
  // the inline style overrides the left-border colour for google_calendar
  // events specifically. Notion CC deadlines override with the warning
  // colour so meetings/deadlines are immediately distinguishable.
  const isGoogle = ev.source === 'google_calendar';
  const accentColor = isGoogle ? 'var(--color-info)' : 'var(--color-warning)';
  const classes = `cal-event ${mod}`;
  const tooltipTitle = isGoogle && ev.account
    ? `${ev.title} · ${ev.account}`
    : ev.title;

  const baseStyle: CSSProperties = {
    top: pos.top,
    height: pos.height,
    borderLeft: `3px solid ${accentColor}`,
  };

  const inner = (
    <>
      <div className="cal-event-title">{ev.title}</div>
      <div className="cal-event-meta">{formatTimeRange(ev.start_at, ev.end_at)}</div>
    </>
  );

  if (ev.linked_entity_id) {
    return (
      <Link
        href={`/entities/${ev.linked_entity_id}` as never}
        className={classes}
        style={baseStyle}
        data-testid="calendar-event"
        data-bolag={bolagCls}
        data-source={ev.source}
        title={tooltipTitle}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div
      className={classes}
      style={baseStyle}
      data-testid="calendar-event"
      data-bolag={bolagCls}
      data-source={ev.source}
      title={tooltipTitle}
    >
      {inner}
    </div>
  );
}

export function CalendarWeekView({ initial }: { initial: CalendarWeekResponse }) {
  const [data, setData] = useState<CalendarWeekResponse>(initial);
  const router = useRouter();

  const anchor = useMemo(() => new Date(initial.start), [initial.start]);
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const today = new Date();

  const onTimelineEvent = useCallback(() => {
    // Re-fetch the current week on any timeline_event push. Cheap at
    // Kevin-scale (< 100 events/week) and idempotent per Plan 07 contract.
    void fetch(`/api/calendar/week?start=${encodeURIComponent(initial.start)}&end=${encodeURIComponent(initial.end)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CalendarWeekResponse>) : null))
      .then((p) => {
        if (p) setData(p);
        router.refresh();
      })
      .catch(() => {
        /* silent — UI-SPEC §Copywriting */
      });
  }, [initial.start, initial.end, router]);
  useSseKind('timeline_event', onTimelineEvent);

  const hasEvents = data.events.length > 0;

  return (
    <div className="flex flex-col gap-5" data-testid="calendar-week">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.012em] text-[color:var(--color-text)]">
            Calendar
          </h1>
          <p className="text-[13px] text-[color:var(--color-text-3)]">
            This week · {data.events.length} event{data.events.length === 1 ? '' : 's'}
          </p>
        </div>

        <Tabs defaultValue="week" className="w-fit">
          <TabsList variant="line">
            <TabsTrigger value="week">Week</TabsTrigger>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <TabsTrigger value="month" disabled data-testid="month-tab">
                    Month
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent>Month view ships with Phase 8</TooltipContent>
            </Tooltip>
          </TabsList>
        </Tabs>
      </div>

      {hasEvents ? (
        <>
          {/* Plan 11-05 Task 2: Legend mapping accent colour → event kind. */}
          <div
            data-testid="cal-legend"
            style={{
              display: 'flex',
              gap: 16,
              fontSize: 11,
              color: 'var(--color-text-3)',
              alignItems: 'center',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  background: 'var(--color-info)',
                  borderRadius: 2,
                }}
              />
              Meetings (Google)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  background: 'var(--color-warning)',
                  borderRadius: 2,
                }}
              />
              Deadlines (Command Center)
            </span>
          </div>

          <div className="week-grid">
            {/* Header row: time gutter + 7 day headers */}
            <div className="week-th" aria-hidden />
            {days.map((d) => {
              const isToday = sameDay(d, today);
              return (
                <div
                  key={`th-${d.toISOString()}`}
                  className={`week-th${isToday ? ' today-col' : ''}`}
                  data-testid={isToday ? 'today-col-header' : 'day-col-header'}
                >
                  {DAY_LABELS_SV[(d.getDay() + 6) % 7]}
                  <div className="day-num">{d.getDate()}</div>
                </div>
              );
            })}

            {/* Hourly rows: time label + 7 day cells */}
            {HOURS.map((hour) => (
              <Hour key={hour} hour={hour} days={days} today={today} events={data.events} />
            ))}
          </div>
        </>
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-2 py-20"
          data-testid="cal-empty"
        >
          <p className="text-[14px] text-[color:var(--color-text-2)]">
            No meetings or deadlines this week — your calendar is clear.
          </p>
          <p className="text-[12px] text-[color:var(--color-text-3)]">
            Google Calendar meetings and Command Center deadlines surface here as they arrive.
          </p>
        </div>
      )}
    </div>
  );
}

function Hour({
  hour,
  days,
  today,
  events,
}: {
  hour: number;
  days: Date[];
  today: Date;
  events: CalendarEvent[];
}) {
  return (
    <>
      <div className="week-time">{formatHour(hour)}</div>
      {days.map((d) => {
        const isToday = sameDay(d, today);
        // Render each event once, pinned by its start hour.
        const starting = events.filter((ev) => {
          const s = new Date(ev.start_at);
          return sameDay(s, d) && s.getHours() === hour;
        });
        return (
          <div
            key={`cell-${d.toISOString()}-${hour}`}
            className={`week-cell${isToday ? ' today-col' : ''}`}
            style={{ minHeight: ROW_HEIGHT_PX }}
          >
            {starting.map((ev) => (
              <EventBar key={ev.id} ev={ev} day={d} />
            ))}
          </div>
        );
      })}
    </>
  );
}
