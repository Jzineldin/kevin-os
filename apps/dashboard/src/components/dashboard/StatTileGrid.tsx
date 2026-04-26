/**
 * StatTileGrid — 4-column desktop grid wrapper for StatTile rows.
 *
 * Open question for Wave 2: confirm 4-column layout is desktop-only — Wave 4
 * polish handles tablet collapse (per 11-02 PLAN <output>).
 */
import { type ReactNode } from 'react';

export function StatTileGrid({ children }: { children: ReactNode }) {
  return (
    <div
      className="mc-stat-tile-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}
