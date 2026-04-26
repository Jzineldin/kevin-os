/**
 * PriorityRow — extends the existing `.pri-row` CSS primitive (globals.css
 * lines 207-214) for use in the mission-control activity feed.
 *
 * Visual reference: 11-RESEARCH.md "Visual Pattern Reference" — descending
 * priority numbers (100, 99, 95, …) with title + meta + hover-revealed actions.
 * Analog: today/PriorityList.tsx (existing usage of `.pri-*` classes).
 *
 * When `onClick` is provided the row renders as a `<button>` for keyboard
 * navigation (D-11 keyboard floor); otherwise it renders as a `<div>`.
 */
import type { ReactNode } from 'react';

export function PriorityRow({
  priority,
  title,
  meta,
  actions,
  onClick,
}: {
  priority: number;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="pri-row"
        data-priority={priority}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span className="pri-num">{priority}</span>
        <div>
          <div className="pri-title">{title}</div>
          {meta ? <div className="pri-meta">{meta}</div> : null}
        </div>
        <div className="pri-actions">{actions}</div>
      </button>
    );
  }
  return (
    <div className="pri-row" data-priority={priority}>
      <span className="pri-num">{priority}</span>
      <div>
        <div className="pri-title">{title}</div>
        {meta ? <div className="pri-meta">{meta}</div> : null}
      </div>
      <div className="pri-actions">{actions}</div>
    </div>
  );
}
