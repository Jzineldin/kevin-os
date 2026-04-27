'use client';

/**
 * IntegrationsHealthView — v4 polished. Uses Panel primitives so the
 * capture-channels and scheduler sections match the Today visual
 * language. Channel section → sect-channels (sage); Scheduler section
 * → sect-priority (blue — it's ops/priority work).
 *
 * SSE refresh re-uses the existing `inbox_item` kind (Phase 11 SSE
 * invariant: no new kinds). Every agent run flows through inbox_item
 * which covers the underlying agent_runs table this page surfaces.
 *
 * D-12 empty-state strategy: when both channels and schedulers are
 * empty (dashboard-api unreachable / first cold-start) we render a
 * single PulseDot + informative line rather than two empty sections.
 */
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

import type { IntegrationsHealthResponse } from '@kos/contracts/dashboard';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';
import { PulseDot } from '@/components/system/PulseDot';
import { ChannelHealth } from '@/components/dashboard/ChannelHealth';
import { Panel } from '@/components/dashboard/Panel';

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
  return 'var(--color-text-4)';
}

function statusBg(s: 'ok' | 'fail' | 'pending' | null): string {
  if (s === 'ok')
    return 'color-mix(in srgb, var(--color-success) 12%, transparent)';
  if (s === 'fail')
    return 'color-mix(in srgb, var(--color-danger) 12%, transparent)';
  if (s === 'pending')
    return 'color-mix(in srgb, var(--color-warning) 12%, transparent)';
  return 'var(--color-surface-2)';
}

function statusBorder(s: 'ok' | 'fail' | 'pending' | null): string {
  if (s === 'ok')
    return 'color-mix(in srgb, var(--color-success) 28%, transparent)';
  if (s === 'fail')
    return 'color-mix(in srgb, var(--color-danger) 28%, transparent)';
  if (s === 'pending')
    return 'color-mix(in srgb, var(--color-warning) 28%, transparent)';
  return 'var(--color-border)';
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

  useSseKind('inbox_item', onRefresh);

  const totalRows = data.channels.length + data.schedulers.length;

  if (totalRows === 0) {
    return (
      <div
        data-testid="integrations-health-view"
        className="fade-up"
        style={{ height: '60vh', display: 'grid', placeItems: 'center' }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2">
            <PulseDot tone="success" />
            <span
              style={{
                color: 'var(--color-text)',
                fontWeight: 500,
                fontSize: 15,
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
              maxWidth: 380,
              lineHeight: 1.55,
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
      className="stagger flex flex-col gap-6"
    >
      <header>
        <h1 className="h-page" style={{ marginBottom: 8 }}>
          Integrations Health
        </h1>
        <p className="h-page-meta">
          {data.channels.length} channel{data.channels.length === 1 ? '' : 's'} ·{' '}
          {data.schedulers.length} scheduler{data.schedulers.length === 1 ? '' : 's'}
        </p>
      </header>

      <Panel
        tone="channels"
        name="Capture channels"
        count={`· ${data.channels.length}`}
        aria-label="Capture channels"
        testId="channels-section"
      >
        <ChannelHealth channels={data.channels} />
      </Panel>

      <Panel
        tone="priority"
        name="Scheduled jobs"
        count={`· ${data.schedulers.length}`}
        aria-label="Scheduled jobs"
        testId="schedulers-section"
        bodyPadding="flush"
      >
        {data.schedulers.length === 0 ? (
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-text-3)',
              padding: 20,
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
              borderCollapse: 'collapse',
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
                }}
              >
                {['Job', 'Last run', 'Status'].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '10px 20px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      color: 'var(--color-text-4)',
                      borderBottom: '1px solid var(--rail)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.schedulers.map((s) => (
                <tr
                  key={s.name}
                  style={{ borderBottom: '1px solid var(--rail)' }}
                  data-testid={`scheduler-row-${s.name}`}
                >
                  <td
                    style={{
                      padding: '12px 20px',
                      color: 'var(--color-text)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                    }}
                  >
                    {s.name}
                  </td>
                  <td
                    style={{
                      padding: '12px 20px',
                      color: 'var(--color-text-3)',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {timeAgo(s.last_run_at)}
                  </td>
                  <td style={{ padding: '12px 20px' }}>
                    <span
                      data-tone={s.last_status ?? 'neutral'}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 20,
                        padding: '0 10px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: 'var(--font-mono)',
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: statusFg(s.last_status),
                        background: statusBg(s.last_status),
                        border: `1px solid ${statusBorder(s.last_status)}`,
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
      </Panel>
    </div>
  );
}
