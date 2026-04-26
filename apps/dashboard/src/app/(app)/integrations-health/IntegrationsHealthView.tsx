'use client';

/**
 * IntegrationsHealthView (Plan 11-06) — client wrapper that renders the
 * mission-control "Cron Jobs"-style page: capture channels list (re-using
 * the ChannelHealth component from Plan 11-02) + scheduler status table.
 *
 * SSE refresh: subscribes to the existing `inbox_item` kind (per Phase 11
 * SSE rule "no new kinds — re-use inbox_item"). Every captured event in
 * the system bumps agent_runs, which is what this page renders, so
 * inbox_item is the right trigger.
 *
 * D-12 empty-state strategy: when both channels and schedulers are
 * empty (dashboard-api unreachable / first cold-start before any
 * agent_run rows exist) we render a single PulseDot + informative line
 * rather than two empty section headers.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import type { IntegrationsHealthResponse } from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';
import { PulseDot } from '@/components/system/PulseDot';
import { ChannelHealth } from '@/components/dashboard/ChannelHealth';

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

function statusFg(s: 'ok' | 'fail' | 'pending' | null): string {
  if (s === 'ok') return 'var(--color-success)';
  if (s === 'fail') return 'var(--color-danger)';
  if (s === 'pending') return 'var(--color-warning)';
  return 'var(--color-text-3)';
}

function statusBg(s: 'ok' | 'fail' | 'pending' | null): string {
  if (s === 'ok')
    return 'color-mix(in srgb, var(--color-success) 15%, transparent)';
  if (s === 'fail')
    return 'color-mix(in srgb, var(--color-danger) 15%, transparent)';
  if (s === 'pending')
    return 'color-mix(in srgb, var(--color-warning) 15%, transparent)';
  return 'transparent';
}

export function IntegrationsHealthView({
  data,
}: {
  data: IntegrationsHealthResponse;
}) {
  const router = useRouter();
  const { announce } = useLiveRegion();

  const onRefresh = useCallback(() => {
    announce('Integrations refreshed');
    router.refresh();
  }, [announce, router]);

  // D-14: re-use the existing inbox_item SSE kind. Phase 11 invariant:
  // no new SSE kinds. Every capture/agent run flows through inbox_item,
  // so this fires often enough to keep the page near-real-time without
  // polling.
  useSseKind('inbox_item', onRefresh);

  const totalRows = data.channels.length + data.schedulers.length;

  if (totalRows === 0) {
    return (
      <div
        data-testid="integrations-health-view"
        className="fade-up"
        style={{
          height: '60vh',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PulseDot tone="success" />
            <span
              style={{
                color: 'var(--color-text)',
                fontWeight: 500,
              }}
            >
              No integrations configured yet
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-text-3)',
              margin: 0,
              maxWidth: 360,
            }}
          >
            Channel and scheduler status will surface here as soon as
            captures or scheduled jobs run.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="integrations-health-view"
      className="fade-up"
      style={{ display: 'flex', flexDirection: 'column', gap: 32 }}
    >
      <header>
        <h1 className="h-page" style={{ marginBottom: 6 }}>
          Integrations Health
        </h1>
        <p
          className="h-page-meta mono"
          style={{ margin: 0 }}
        >
          {data.channels.length} channels · {data.schedulers.length} schedulers
        </p>
      </header>

      <section
        data-testid="channels-section"
        aria-labelledby="channels-h"
      >
        <h2
          id="channels-h"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-3)',
            marginBottom: 12,
          }}
        >
          Capture Channels
        </h2>
        <div
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: '4px 16px',
            background: 'var(--color-surface-1)',
          }}
        >
          <ChannelHealth channels={data.channels} />
        </div>
      </section>

      <section
        data-testid="schedulers-section"
        aria-labelledby="schedulers-h"
      >
        <h2
          id="schedulers-h"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-3)',
            marginBottom: 12,
          }}
        >
          Scheduled Jobs
        </h2>
        {data.schedulers.length === 0 ? (
          <p
            style={{
              fontSize: 12,
              color: 'var(--color-text-3)',
              padding: 16,
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              background: 'var(--color-surface-1)',
              margin: 0,
            }}
          >
            No schedulers configured.
          </p>
        ) : (
          <table
            data-testid="schedulers-table"
            style={{
              width: '100%',
              fontSize: 12,
              borderCollapse: 'collapse',
              background: 'var(--color-surface-1)',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <thead>
              <tr style={{ color: 'var(--color-text-3)', textAlign: 'left' }}>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Job</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>
                  Last run
                </th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {data.schedulers.map((s) => (
                <tr
                  key={s.name}
                  style={{
                    borderTop: '1px solid var(--color-border)',
                  }}
                  data-testid={`scheduler-row-${s.name}`}
                >
                  <td
                    style={{
                      padding: '10px 14px',
                      color: 'var(--color-text)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {s.name}
                  </td>
                  <td
                    style={{
                      padding: '10px 14px',
                      color: 'var(--color-text-3)',
                    }}
                  >
                    {timeAgo(s.last_run_at)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span
                      data-tone={s.last_status ?? 'neutral'}
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 500,
                        color: statusFg(s.last_status),
                        background: statusBg(s.last_status),
                      }}
                    >
                      {s.last_status ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
