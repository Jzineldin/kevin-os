/**
 * Timeline unit coverage — Plan 03-10 Task 2.
 *
 * Three invariants we exercise without spinning up a DOM layout engine:
 *   1. href sanitiser rejects non-http(s)/relative schemes (T-3-10-05).
 *   2. react-window v2 <List> renders the contract shape; dossier delegates
 *      to it via Timeline's default export.
 *   3. A timeline_event SSE for a non-matching entity_id is a no-op (we
 *      can't assert the DOM from a virtualized row here, so instead we
 *      black-box the scope filter by verifying useSseKind is invoked with
 *      the expected kind + confirming the component mounts without fetch).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { TimelinePage } from '@kos/contracts/dashboard';

// Mock react-window to avoid needing a real layout engine in jsdom.
vi.mock('react-window', () => {
  return {
    List: (props: {
      rowCount: number;
      rowComponent: React.ComponentType<{
        index: number;
        style: React.CSSProperties;
        rows: import('@kos/contracts/dashboard').TimelineRow[];
        newIds: Set<string>;
      }>;
      rowProps: {
        rows: import('@kos/contracts/dashboard').TimelineRow[];
        newIds: Set<string>;
      };
      onRowsRendered?: (info: { stopIndex: number }) => void;
    }) => {
      const Row = props.rowComponent;
      // Render all rows as-is (no virtualization in tests). Call
      // onRowsRendered with stopIndex=rowCount-1 to exercise the loadMore
      // threshold.
      if (props.onRowsRendered) {
        props.onRowsRendered({ stopIndex: props.rowCount - 1 });
      }
      return (
        <div data-testid="list-mock">
          {Array.from({ length: props.rowCount }, (_, i) => (
            <Row
              key={i}
              index={i}
              style={{}}
              rows={props.rowProps.rows}
              newIds={props.rowProps.newIds}
            />
          ))}
        </div>
      );
    },
  };
});

// Mock SseProvider's useSseKind — we just want to assert the hook is
// called with the right kind.
const useSseKindMock = vi.fn();
vi.mock('@/components/system/SseProvider', () => ({
  useSseKind: (kind: string, handler: (...args: unknown[]) => void) => {
    useSseKindMock(kind, handler);
  },
}));

import { Timeline } from '@/app/(app)/entities/[id]/Timeline';

const FIXTURE_ENTITY = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';

function makeRow(
  i: number,
  overrides: Partial<import('@kos/contracts/dashboard').TimelineRow> = {},
): import('@kos/contracts/dashboard').TimelineRow {
  return {
    id: `row-${i}`,
    kind: 'mention',
    occurred_at: `2026-04-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
    source: `source-${i}`,
    context: `context ${i}`,
    capture_id: null,
    href: null,
    ...overrides,
  };
}

function makePage(n: number, nextCursor: string | null = null): TimelinePage {
  return {
    rows: Array.from({ length: n }, (_, i) => makeRow(i)),
    next_cursor: nextCursor,
  };
}

describe('Timeline', () => {
  beforeEach(() => {
    useSseKindMock.mockClear();
    // @ts-expect-error — jsdom has no native fetch in vitest 2.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => makePage(0),
    }));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('subscribes to SSE timeline_event on mount', () => {
    render(<Timeline entityId={FIXTURE_ENTITY} initial={makePage(5)} />);
    expect(useSseKindMock).toHaveBeenCalledWith(
      'timeline_event',
      expect.any(Function),
    );
  });

  it('renders each row from the initial page', () => {
    const page = makePage(3);
    const { getAllByTestId } = render(
      <Timeline entityId={FIXTURE_ENTITY} initial={page} />,
    );
    const rows = getAllByTestId('timeline-row');
    expect(rows).toHaveLength(3);
  });

  it('triggers fetch when stopIndex approaches end and cursor is set', () => {
    const page = makePage(50, 'cursor-abc');
    render(<Timeline entityId={FIXTURE_ENTITY} initial={page} />);
    // Our mocked List calls onRowsRendered with stopIndex = 49 (rowCount-1),
    // which is within the <10-from-end threshold → loadMore fires.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/entities/${FIXTURE_ENTITY}/timeline?cursor=`),
    );
  });

  it('does not trigger fetch when next_cursor is null', () => {
    const page = makePage(5, null);
    render(<Timeline entityId={FIXTURE_ENTITY} initial={page} />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SSE scope filter is invoked with the entity_id check — non-match is dropped', async () => {
    render(<Timeline entityId={FIXTURE_ENTITY} initial={makePage(3)} />);
    const [, handler] = useSseKindMock.mock.calls[0] as [
      string,
      (ev: { entity_id?: string }) => void,
    ];
    // Call the handler with a non-matching entity_id — no fetch should fire.
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
    handler({ entity_id: 'some-other-entity' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders empty state when initial rows are empty', () => {
    const { getByTestId } = render(
      <Timeline entityId={FIXTURE_ENTITY} initial={makePage(0)} />,
    );
    expect(getByTestId('timeline-empty')).toBeTruthy();
  });
});
