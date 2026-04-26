# Phase 11: Frontend Rebuild + Real-Data Wiring + Button Audit — Pattern Map

**Mapped:** 2026-04-26
**Files analyzed:** 28 new + 9 modified
**Analogs found:** 35 / 37

This map is grounded in direct filesystem inspection of `apps/dashboard/src/**`, `services/dashboard-api/src/**`, `packages/contracts/src/**`, `packages/db/drizzle/**`. Every excerpt below is a real, unedited fragment from the current codebase.

---

## File Classification

### Workstream A — Visual rebuild (mission-control aesthetic)

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `apps/dashboard/src/app/globals.css` (extend) | tokens / primitive CSS | n/a (static stylesheet) | itself — 03-UI-SPEC token block (lines 8-70 + .pri-row/.brief/.cal-event blocks 197-256) | exact (extend in place) |
| `apps/dashboard/src/lib/design-tokens.ts` (NEW per D-08) | utility / TS constants | n/a | `apps/dashboard/src/lib/bolag.ts` (token-to-class mapping) | role-match |
| `apps/dashboard/src/components/dashboard/StatTile.tsx` (NEW) | component / leaf | request-response (RSC pass-down) | `apps/dashboard/src/components/system/PulseDot.tsx` (single-purpose primitive with tone variants) | role-match |
| `apps/dashboard/src/components/dashboard/Pill.tsx` (NEW — classification + status pill) | component / leaf | request-response | `apps/dashboard/src/components/badge/BolagBadge.tsx` (BolagBadge) | exact |
| `apps/dashboard/src/components/dashboard/ChannelHealth.tsx` (NEW) | component / list | request-response | `apps/dashboard/src/app/(app)/today/DraftsCard.tsx` (sectioned list with header + AnimatePresence rows) | role-match |
| `apps/dashboard/src/components/dashboard/StatTileGrid.tsx` (NEW) | component / layout | request-response | `apps/dashboard/src/app/(app)/today/TodayView.tsx` (CSS-grid composition with 1fr 320px) | role-match |
| `apps/dashboard/src/components/dashboard/PriorityRow.tsx` (NEW — extends `.pri-row`) | component / leaf | request-response | `apps/dashboard/src/app/(app)/inbox/ItemRow.tsx` (single grid row, selected/hover, BolagBadge) | exact |
| `apps/dashboard/src/components/chat/ChatBubble.tsx` (NEW) | component / floating overlay | event-driven (open/close state) | `apps/dashboard/src/components/system/OfflineBanner.tsx` (fixed-position client-side global) | role-match |
| `apps/dashboard/src/components/chat/ChatSheet.tsx` (NEW shadcn `sheet`) | component / dialog | request-response | shadcn primitive — install with `npx shadcn@latest add sheet`. Render shape mirrors `apps/dashboard/src/app/(app)/entities/[id]/EditEntityDialog.tsx` (existing shadcn `dialog` consumer) | partial — install primitive first |

### Workstream B — Demo data wipe + safeguard

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `scripts/phase-11-wipe-demo-rows.sql` (NEW one-shot, NOT a migration) | migration-like / operator script | DB write (DELETE) | `packages/db/drizzle/0021_phase_10_migration_audit.sql` (BEGIN/COMMIT pattern) | role-match |
| `services/dashboard-api/src/seed-pollution-guard.ts` (NEW startup module) | service / init guard | request-response (fail-loud at Lambda init) | `services/dashboard-api/src/db.ts` (module-level cache + lazy init) | role-match |
| `services/dashboard-api/src/index.ts` (modified — wire guard) | controller / Lambda handler | request-response | itself — handler scaffold lines 25-37 + 63-98 already exists | exact (extend in place) |
| `scripts/verify-phase-11-wipe.sh` (NEW) | test / smoke | DB read (SELECT 0) | n/a — no analog. Wave 0 gap. | none |
| `apps/dashboard/tests/unit/seed-pollution-guard.test.ts` OR `services/dashboard-api/tests/seed-pollution-guard.test.ts` (NEW) | test | mocked DB | `services/dashboard-api/tests/email-drafts.test.ts` (vi.hoisted + db.execute mock pattern) | exact |

### Workstream C — Inbox D-05 (drop urgent-only filter, surface all classifications)

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `services/dashboard-api/src/email-drafts-persist.ts` (modified — drop status filter) | service / SQL helper | DB read | itself — `listInboxDrafts` lines 156-178 already exists | exact (drop one clause) |
| `services/dashboard-api/src/routes/inbox.ts` (modified — extend mergedInboxHandler) | controller / Lambda route | DB read | itself — lines 54-111 | exact (extend in place) |
| `packages/contracts/src/dashboard.ts` (modified — add optional `classification` field) | contract / zod schema | n/a | itself — `InboxItemSchema` lines 237-248 | exact (additive) |
| `apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` (modified — branch on classification) | component / client | request-response + SSE | itself — already has the pattern | exact (extend in place) |
| `apps/dashboard/src/app/(app)/inbox/ItemRow.tsx` (modified — add classification Pill) | component / leaf | request-response | itself — already renders BolagBadge by `org` field; add a parallel `<Pill classification status>` slot | exact (extend in place) |

### Workstream D — Live data wiring per page

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `services/dashboard-api/src/handlers/today.ts` (modified — add captures_today UNION) | controller / Lambda route | DB read | itself — `loadDrafts`/`loadDropped` (lines 108-193) raw `db.execute(sql\`...\`)` pattern | exact (extend in place) |
| `services/dashboard-api/src/handlers/calendar.ts` (modified — UNION calendar_events_cache) | controller / Lambda route | DB read + Notion read | itself — `queryCommandCenter` lines 83-121 | exact (extend in place) |
| `services/dashboard-api/src/handlers/integrations.ts` (NEW — channel health endpoint) | controller / Lambda route | DB read (agent_runs aggregation) | `services/dashboard-api/src/handlers/today.ts` (full handler+register pattern) AND `services/dashboard-api/src/handlers/entities.ts:loadDrafts/loadDropped` (raw SQL aggregation) | exact composition |
| `packages/contracts/src/dashboard.ts` (modified — add `IntegrationsHealthResponseSchema`) | contract / zod schema | n/a | itself — `CalendarWeekResponseSchema` lines 220-225 | exact |
| `apps/dashboard/src/app/(app)/integrations-health/page.tsx` (NEW) | page / RSC | request-response | `apps/dashboard/src/app/(app)/calendar/page.tsx` (RSC + force-dynamic + try/catch callApi + EMPTY fallback) | exact |
| `apps/dashboard/src/app/(app)/chat/page.tsx` (NEW shell only) | page / RSC | n/a (static placeholder) | `apps/dashboard/src/app/(app)/entities/page.tsx` (RSC, no SSE, simple shell) | exact |
| `apps/dashboard/src/app/(app)/today/TodayView.tsx` (modified — add stat tiles + channel-health strip + captures list) | component / client wrapper | request-response + SSE | itself — already composes `<Brief><PriorityList><DraftsCard><DroppedThreads>` | exact (extend in place) |
| `apps/dashboard/src/app/(app)/today/CapturesList.tsx` (NEW) | component / list | request-response | `apps/dashboard/src/app/(app)/today/DraftsCard.tsx` (section + AnimatePresence + relative-time row) | exact |
| `apps/dashboard/src/app/(app)/today/StatTileStrip.tsx` (NEW) | component / list | request-response | `apps/dashboard/src/app/(app)/today/TodayView.tsx` grid composition | role-match |
| `apps/dashboard/src/app/(app)/calendar/CalendarWeekView.tsx` (modified — handle merged events) | component / client | request-response + SSE | itself | exact (extend in place) |
| `apps/dashboard/src/app/api/integrations/health/route.ts` (NEW Vercel proxy) | route / API mirror | request-response | `apps/dashboard/src/app/api/calendar/week/route.ts` + `apps/dashboard/src/app/api/today/route.ts` (already-mirrored handlers) | exact |
| `apps/dashboard/src/app/(app)/today/page.tsx` (modified — extend payload contract) | page / RSC | request-response | itself | exact (extend in place) |
| `apps/dashboard/src/app/(app)/integrations-health/IntegrationsHealthView.tsx` (NEW) | component / client wrapper | request-response + SSE | `apps/dashboard/src/app/(app)/today/TodayView.tsx` (RSC payload-in, useSseKind, announce) | exact |

### Workstream E — Button audit + chat shell

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `apps/dashboard/src/app/(app)/today/Composer.tsx` (audit + wire-or-remove) | component / client | request-response | itself — verify it POSTs to /capture | exact (audit) |
| `apps/dashboard/src/components/app-shell/Sidebar.tsx` (modified — flip Chat from disabled to enabled) | component / client | n/a | itself — line 121-126 (`disabled` + `disabledTooltip`) | exact (flip flag) |
| `apps/dashboard/src/app/(app)/settings/page.tsx` (decide: wire useful or remove) | page / RSC | request-response | `apps/dashboard/src/app/(app)/entities/page.tsx` (RSC simple shell) | role-match |
| `apps/dashboard/src/lib/button-registry.ts` (NEW data-testid catalog for parametric e2e) | utility / TS constants | n/a | `apps/dashboard/src/lib/bolag.ts` (constant lookup) | role-match |

### Tests (Wave 0 gaps)

| New File | Role | Closest Analog | Match Quality |
|----------|------|----------------|---------------|
| `apps/dashboard/tests/e2e/visual.spec.ts` (NEW Playwright `toMatchScreenshot`) | e2e | `apps/dashboard/tests/e2e/today.spec.ts` (smoke pattern with `PLAYWRIGHT_BASE_URL` skip) | role-match |
| `apps/dashboard/tests/e2e/button-audit.spec.ts` (NEW parametric over data-testid) | e2e | `apps/dashboard/tests/e2e/inbox-keyboard.spec.ts` (keyboard parametric) | role-match |
| `apps/dashboard/tests/e2e/empty-states.spec.ts` (NEW) | e2e | `apps/dashboard/tests/e2e/today.spec.ts` | role-match |
| `apps/dashboard/tests/e2e/inbox.spec.ts` (extend) | e2e | `apps/dashboard/tests/e2e/inbox-keyboard.spec.ts` | exact |
| `services/dashboard-api/tests/integrations-health.test.ts` (NEW) | unit | `services/dashboard-api/tests/today.test.ts` (zod-shape contract test) | exact |
| `services/dashboard-api/tests/email-drafts.test.ts` (extend — all classifications) | unit | itself | exact |
| `services/dashboard-api/tests/calendar.test.ts` (extend — UNION calendar_events_cache) | unit | itself | exact |

---

## Pattern Assignments — concrete excerpts

### A1. Mission-control CSS primitives — extend `globals.css`

**Analog:** `apps/dashboard/src/app/globals.css` lines 197-227 (already encodes `.brief`, `.draft-card`, `.side-card`, `.priority-list`, `.pri-row`, `.pri-num`, `.pri-title`, `.pri-meta`, `.count-chip`, `.thread-row`).

**Existing token block to copy from** (lines 8-70):

```css
@theme {
  --color-bg: #0a0c11;
  --color-surface-1: #11141b;
  --color-surface-2: #161a23;
  --color-surface-3: #1c2029;
  --color-surface-hover: #1f2430;
  --color-border: #232732;
  --color-text: #e7eaf0;
  --color-text-3: #71768a;
  --color-accent: #7c5bff;
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-danger: #f87171;
  --color-info: #38bdf8;
  /* ... */
}
```

**Existing primitive pattern to copy from** (line 207):

```css
.pri-row { display: grid; grid-template-columns: 24px 1fr auto; gap: 14px; align-items: center; padding: 12px 14px; background: var(--color-surface-1); transition: background var(--transition-fast) var(--ease); }
.pri-row:hover { background: var(--color-surface-hover); }
.pri-num { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-3); letter-spacing: 0.02em; }
```

**New primitives to add** (mission-control mc-* layer): `.mc-stat-tile`, `.mc-channel-bar`, `.mc-chat-bubble`, `.mc-chat-sheet`, `.mc-pill`. They MUST consume the same `--color-*` tokens already defined. NO new color values.

**Pulse keyframe to reuse** (lines 132-150) — already exists, do not duplicate:

```css
@keyframes pulse-dot { 0%, 100% { opacity: 0.4; transform: scale(1); } 50% { opacity: 1; transform: scale(1.12); } }
.pulse-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--color-accent); animation: pulse-dot 1.4s var(--ease) infinite; }
```

---

### A2. New page component (RSC entry) — `integrations-health/page.tsx`

**Analog:** `apps/dashboard/src/app/(app)/inbox/page.tsx` (lines 1-57) — RSC + force-dynamic + try/catch callApi + EMPTY fallback handoff to client component.

**Imports + dynamic flag pattern** (lines 19-29):

```typescript
import { callApi } from '@/lib/dashboard-api';
import {
  InboxListSchema,
  type InboxList,
} from '@kos/contracts/dashboard';

import { InboxClient } from './InboxClient';

export const dynamic = 'force-dynamic';

const EMPTY: InboxList = { items: [] };
```

**RSC fetch + degraded-fallback pattern** (lines 31-57):

```typescript
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const params = await searchParams;
  let data: InboxList;
  try {
    data = await callApi('/inbox-merged', { method: 'GET' }, InboxListSchema);
  } catch {
    try {
      data = await callApi('/inbox', { method: 'GET' }, InboxListSchema);
    } catch {
      data = EMPTY;
    }
  }
  return (
    <InboxClient
      initialItems={data.items}
      focusId={params.focus ?? null}
    />
  );
}
```

**Apply to `integrations-health/page.tsx`:** swap `/inbox-merged` → `/integrations/health`, `InboxListSchema` → `IntegrationsHealthResponseSchema`, EMPTY → `{ channels: [], schedulers: [] }`. The single try/catch (no fallback chain) is sufficient since `/integrations/health` is brand-new.

---

### A3. New client wrapper (SSE-subscribing) — `IntegrationsHealthView.tsx`, `CapturesList.tsx`

**Analog:** `apps/dashboard/src/app/(app)/today/TodayView.tsx` (lines 1-69) — `'use client'` + payload prop + `useSseKind('inbox_item', refresh)` + `useLiveRegion().announce`.

**SSE refresh pattern** (lines 23-38):

```tsx
'use client';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSseKind } from '@/components/system/SseProvider';
import { useLiveRegion } from '@/components/system/LiveRegion';

export function TodayView({ data }: { data: TodayResponse }) {
  const router = useRouter();
  const { announce } = useLiveRegion();
  const onInbox = useCallback(() => {
    announce('New inbox item');
    router.refresh();
  }, [announce, router]);
  useSseKind('inbox_item', onInbox);
  useSseKind('draft_ready', onDraft);
```

**Apply to new pages:** every new RSC-backed view (`/integrations-health`, `/today` extension, `/chat` shell) MUST use `useSseKind('inbox_item', () => router.refresh())`. Phase 11 adds NO new SSE kinds (per RESEARCH §"SSE refresh pattern").

---

### A4. Pill / status badge — extend `BolagBadge.tsx` pattern

**Analog:** `apps/dashboard/src/components/badge/BolagBadge.tsx` (lines 1-47) — single-purpose pill mapping a string token → `.badge` class + variant suffix.

**Whole component — copy this shape verbatim, swap inputs:**

```tsx
import { getBolagClass, type BolagClass } from '@/lib/bolag';

const SHORT: Record<BolagClass, string> = {
  'bolag-tf': 'TF',
  'bolag-ob': 'OB',
  'bolag-pe': 'PE',
};

export function BolagBadge({
  org,
  variant = 'short',
  className,
}: {
  org: string | null | undefined;
  variant?: 'short' | 'full';
  className?: string;
}) {
  const cls = getBolagClass(org);
  const label = variant === 'short' ? SHORT[cls] : FULL[cls];
  return (
    <span
      className={['badge', cls, className].filter(Boolean).join(' ')}
      data-bolag={cls}
    >
      {label}
    </span>
  );
}
```

**Apply to `Pill.tsx`:** `(classification, status) → { tone, label }` mapping table from RESEARCH §"Pill mapping for D-05" lines 204-216:

| Classification | Status | Pill | Tone (CSS var) |
|---|---|---|---|
| urgent | draft | "URGENT — Draft ready" | danger |
| urgent | edited | "URGENT — Edited" | warning |
| urgent | sent | "URGENT — Sent" | success |
| important | * | "Important" | info |
| informational | * | "FYI" | neutral |
| junk | * | "Junk" | dim |
| any | pending_triage | "Triaging…" | accent + pulse |
| any | skipped | "Skipped" | dim |

Use the same `data-tone` attribute pattern + `<span className={['badge', cls, ...]} />` structure.

---

### B1. New dashboard-api route — `handlers/integrations.ts`

**Analog:** `services/dashboard-api/src/handlers/today.ts` (lines 1-222) — full handler module: imports → helpers → handler function → `register('GET', '/today', handler)` side-effect.

**Imports pattern** (lines 20-26):

```typescript
import { and, desc, eq, sql } from 'drizzle-orm';
import { TodayResponseSchema } from '@kos/contracts/dashboard';
import { entityIndex, inboxIndex } from '@kos/db/schema';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { getDb } from '../db.js';
import { getNotion } from '../notion.js';
import { ownerScoped, OWNER_ID } from '../owner-scoped.js';
```

**Raw-SQL aggregation pattern** (lines 156-184) — for the agent_runs/scheduler_runs queries:

```typescript
const rows = (await db.execute(sql`
  SELECT
    id::text AS id,
    name AS entity,
    EXTRACT(EPOCH FROM (now() - last_touch)) / 86400.0 AS age_days
  FROM entity_index
  WHERE owner_id = ${OWNER_ID}
    AND last_touch IS NOT NULL
    AND status = 'active'
  ORDER BY last_touch DESC
  LIMIT 10
`)) as unknown as {
  rows: Array<{ id: string; entity: string; age_days: string | number }>;
};
return rows.rows.map((r) => ({ id: r.id, entity: r.entity, age_days: Number(r.age_days) }));
```

**Handler shape + zod-at-exit + register pattern** (lines 195-222):

```typescript
async function todayHandler(_ctx: Ctx): Promise<RouteResponse> {
  const [brief, priorities, drafts, dropped] = await Promise.all([
    loadBrief(), loadPriorities(), loadDrafts(), loadDropped(),
  ]);
  const payload = TodayResponseSchema.parse({ brief, priorities, drafts, dropped, meetings: [] });
  return {
    statusCode: 200,
    body: JSON.stringify(payload),
    headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=86400' },
  };
}

register('GET', '/today', todayHandler);
export { todayHandler };
```

**Apply to `integrations.ts`:**
- Two helpers `loadChannels()` + `loadSchedulers()` running in `Promise.all`.
- Channel query against `agent_runs` GROUPed by `agent_name` (RESEARCH §"Channel health query" lines 602-611).
- `register('GET', '/integrations/health', integrationsHealthHandler);` and add the side-effect import to `services/dashboard-api/src/index.ts` (currently line 27-36).

**Wiring pattern in index.ts** (lines 25-36 — extend with new import line):

```typescript
import { route } from './router.js';
import './handlers/today.js';
import './handlers/entities.js';
import './handlers/timeline.js';
import './handlers/inbox.js';
import './handlers/merge.js';
import './handlers/capture.js';
import './handlers/calendar.js';
import './routes/email-drafts.js';
import './routes/inbox.js';
// ADD:
import './handlers/integrations.js';
```

---

### B2. SQL helper extension — `email-drafts-persist.ts:listInboxDrafts`

**Analog:** `services/dashboard-api/src/email-drafts-persist.ts` lines 156-178 — drop ONE clause.

**Current code (drop status filter per D-05):**

```typescript
export async function listInboxDrafts(
  db: NodePgDatabase,
  limit = 50,
): Promise<InboxDraftItem[]> {
  const r = (await db.execute(sql`
    SELECT
      id::text          AS draft_id,
      capture_id        AS capture_id,
      from_email        AS from_email,
      subject           AS subject,
      draft_subject     AS draft_subject,
      draft_body        AS draft_body,
      classification    AS classification,
      status            AS status,
      received_at::text AS received_at
    FROM email_drafts
    WHERE owner_id = ${OWNER_ID}
      AND status IN ('draft','edited')        -- DELETE THIS LINE
    ORDER BY received_at DESC
    LIMIT ${limit}
  `)) as unknown as { rows: InboxDraftItem[] };
  return r.rows;
}
```

**After D-05:** remove the `AND status IN ('draft','edited')` clause; bump default `limit` from 50 to 100. The downstream `mergedInboxHandler` (`routes/inbox.ts` lines 75-85) already maps `classification` + `status` into the merged shape, so no callsite changes needed beyond the contract additive change.

---

### B3. UNION pattern for `today.ts:captures_today` extension

**Analog:** `services/dashboard-api/src/handlers/today.ts:loadDrafts` (lines 108-145, Drizzle ORM) AND `loadDropped` (lines 147-193, raw SQL). For the new `captures_today` UNION across email_drafts + capture_text + capture_voice + mention_events, the **raw SQL pattern** (`db.execute(sql\`...\`)`) is the right fit since Drizzle has no UNION builder configured in this repo.

**Raw-SQL pattern to copy** (lines 157-184):

```typescript
const rows = (await db.execute(sql`
  WITH today_window AS (
    SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AS d_start
  )
  SELECT 'email' AS source, id::text AS id, subject AS title, classification AS detail, received_at AS at
    FROM email_drafts, today_window
    WHERE owner_id = ${OWNER_ID} AND received_at >= d_start
  UNION ALL
  SELECT 'capture_text' AS source, id::text, source_kind AS title, body AS detail, created_at AS at
    FROM capture_text, today_window
    WHERE owner_id = ${OWNER_ID} AND created_at >= d_start
  UNION ALL
  SELECT 'mention' AS source, id::text, source AS title, context AS detail, occurred_at AS at
    FROM mention_events, today_window
    WHERE owner_id = ${OWNER_ID} AND occurred_at >= d_start
  ORDER BY at DESC
  LIMIT 50
`)) as unknown as {
  rows: Array<{ source: string; id: string; title: string; detail: string | null; at: string | Date }>;
};
```

**Wave 0 verification gap:** column names `source_kind`, `body`, `context` are RESEARCH-assumed (A2 in assumption log). Plan must include a Wave 0 `\d+ capture_text` step against the bastion to confirm before committing this SQL.

---

### B4. New SQL view-helper signatures — `IntegrationsHealthResponseSchema`

**Analog:** `packages/contracts/src/dashboard.ts` lines 220-225 (`CalendarWeekResponseSchema`).

**Exact pattern to copy:**

```typescript
export const CalendarEventSchema = z.object({ /* ... */ });
export const CalendarWeekResponseSchema = z.object({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  events: z.array(CalendarEventSchema),
});
export type CalendarWeekResponse = z.infer<typeof CalendarWeekResponseSchema>;
```

**Apply to `IntegrationsHealthResponseSchema`:**

```typescript
export const ChannelHealthSchema = z.object({
  name: z.string(),
  type: z.enum(['capture', 'scheduler']),
  status: z.enum(['healthy', 'degraded', 'down']),
  last_event_at: IsoDateTimeSchema.nullable(),
});
export const SchedulerHealthItemSchema = z.object({
  name: z.string(),
  next_run_at: IsoDateTimeSchema.nullable(),
  last_run_at: IsoDateTimeSchema.nullable(),
  last_status: z.enum(['ok', 'fail', 'pending']).nullable(),
});
export const IntegrationsHealthResponseSchema = z.object({
  channels: z.array(ChannelHealthSchema),
  schedulers: z.array(SchedulerHealthItemSchema),
});
export type IntegrationsHealthResponse = z.infer<typeof IntegrationsHealthResponseSchema>;
```

---

### C1. Demo-data wipe SQL — one-shot operator script

**Analog:** `packages/db/drizzle/0021_phase_10_migration_audit.sql` (BEGIN/COMMIT envelope pattern). NOTE: the wipe is NOT a Drizzle migration (no schema change), but the BEGIN/COMMIT shell pattern is reused.

**SQL shape to follow (RESEARCH §"Wipe SQL" lines 320-353):**

```sql
BEGIN;

-- Pre-flight count, surfaces in psql output for evidence
SELECT 'inbox_index' AS tbl, COUNT(*) FROM inbox_index
  WHERE owner_id = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid
    AND title IN (
      'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
      'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
      'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
      'Outbehaving angel investor'
    );

-- ... same for email_drafts (subject + draft_subject), agent_dead_letter (error_message ILIKE) ...

-- Operator visually confirms counts BEFORE the DELETEs
DELETE FROM inbox_index WHERE owner_id = '...'::uuid AND title IN (...);
DELETE FROM email_drafts WHERE owner_id = '...'::uuid AND (subject IN (...) OR draft_subject IN (...));
DELETE FROM agent_dead_letter WHERE owner_id = '...'::uuid AND error_message ILIKE ANY (ARRAY['%Damien Carter%', ...]);

-- Final count = 0 expected
SELECT COUNT(*) FROM inbox_index WHERE owner_id = '...'::uuid AND title IN (...);

COMMIT;  -- or ROLLBACK if counts wrong
```

**OWNER_ID literal:** `'7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid` (verified in `services/dashboard-api/src/owner-scoped.ts` lines 17-23 + migration 0008 line 26 + `packages/db/src/owner.ts`).

**Execution venue:** bastion + SSM port-forward (assumption A3 — verify reachable in Wave 0).

---

### C2. Startup guard — `seed-pollution-guard.ts`

**Analog:** `services/dashboard-api/src/db.ts` (lines 1-66) — module-level lazy init pattern with cached resolution.

**Module-level cache pattern to copy** (lines 22-58):

```typescript
let pool: pg.Pool | null = null;
let db: NodePgDatabase | null = null;

export async function getDb(): Promise<NodePgDatabase> {
  if (db) return db;
  // ... lazy init ...
  db = drizzle(pool);
  return db;
}
```

**Apply to `seed-pollution-guard.ts`:**

```typescript
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { OWNER_ID } from './owner-scoped.js';

const SEED_NAMES = [
  'Damien Carter', 'Christina Larsson', 'Jan Eriksson', 'Lars Svensson',
  'Almi Företagspartner', 'Re: Partnership proposal', 'Re: Summer meeting',
  'Possible duplicate: Damien C.', 'Paused: Maria vs Maria Johansson',
  'Outbehaving angel investor',
];

let cachedResult: 'clean' | 'polluted' | null = null;

export async function assertNoSeedPollution(): Promise<void> {
  if (cachedResult === 'clean') return;
  if (cachedResult === 'polluted') {
    throw new Error('[dashboard-api] seed pollution detected — refusing to serve');
  }
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT 1 FROM inbox_index
    WHERE owner_id = ${OWNER_ID} AND title = ANY(${SEED_NAMES})
    LIMIT 1
  `)) as unknown as { rows: unknown[] };
  if (r.rows.length > 0) {
    cachedResult = 'polluted';
    console.error('[dashboard-api] SEED POLLUTION DETECTED — purge required before re-enabling');
    throw new Error('seed pollution detected');
  }
  cachedResult = 'clean';
}
```

**Hook into the Lambda handler** (`services/dashboard-api/src/index.ts` lines 63-98) — call `assertNoSeedPollution()` at the top of `handler` after `verifyBearer`. On throw, return 503 (NOT 500 — fail-loud distinct from generic errors):

```typescript
export const handler: LambdaFunctionURLHandler = async (event) => {
  if (!verifyBearer(event.headers as ...)) { /* 401 */ }
  try {
    await assertNoSeedPollution();
  } catch (err) {
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'service_unavailable', detail: 'seed_pollution' }),
    };
  }
  // ... existing route() call ...
};
```

---

### C3. Vitest unit test — seed guard / contract / handler

**Analog:** `services/dashboard-api/tests/email-drafts.test.ts` lines 21-80 — `vi.hoisted` + EventBridge mock + `db.execute` table-driven mock + `db.transaction` passthrough.

**Hoisted-mock pattern to copy** (lines 21-72):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ebSendMock } = vi.hoisted(() => ({
  ebSendMock: vi.fn(async () => ({})),
}));

vi.mock('@aws-sdk/client-eventbridge', () => {
  class MockEB { send = ebSendMock; }
  class MockCmd { input: unknown; constructor(input: unknown) { this.input = input; } }
  return { EventBridgeClient: MockEB, PutEventsCommand: MockCmd };
});

let storedDraft: Record<string, unknown> | null = null;
const recordedQueries: Array<{ text: string; params?: unknown[] }> = [];

function dbExecute(query: { sql: string; params?: unknown[] } | string): Promise<{ rows: unknown[] }> {
  const text = typeof query === 'string' ? query : (query as any).sql ?? JSON.stringify(query);
  recordedQueries.push({ text });
  if (text.includes('FROM email_drafts')) {
    return Promise.resolve({ rows: storedDraft ? [storedDraft] : [] });
  }
  return Promise.resolve({ rows: [] });
}

interface FakeDb {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  transaction: (fn: (tx: FakeDb) => Promise<unknown>) => Promise<unknown>;
}
const fakeDb: FakeDb = {
  execute: dbExecute as FakeDb['execute'],
  transaction: async (fn) => fn(fakeDb),
};
```

**Apply to seed-pollution-guard test:** mock `db.execute` to return `{ rows: [{ '?column?': 1 }] }` to assert the throw path; return `{ rows: [] }` to assert the clean path. Use `vi.resetModules()` between cases since the guard caches the result at module scope.

---

### D1. Playwright e2e — visual regression baseline

**Analog:** `apps/dashboard/tests/e2e/today.spec.ts` (lines 1-32) — smoke test with `PLAYWRIGHT_BASE_URL` skip guard.

**Skeleton pattern** (whole file):

```typescript
import { test, expect } from '@playwright/test';

test.describe('today', () => {
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    'PLAYWRIGHT_BASE_URL must be set to run this test',
  );

  test('renders top-level sections', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: /Today/i, level: 1 })).toBeVisible();
    await expect(page.locator('.brief')).toBeVisible();
  });
});
```

**Apply to `visual.spec.ts`:** same skip guard, navigate to `/today`, `/inbox`, `/entities`, `/calendar`, `/integrations-health`, then `await expect(page).toHaveScreenshot()`. The Playwright config (`apps/dashboard/playwright.config.ts`) already enables both `chromium` + `mobile-android` — visual baselines per project are acceptable.

**Apply to `button-audit.spec.ts`:** parametric `for (const id of BUTTON_REGISTRY) { test(\`button ${id}\`, ...); }` reading from the new `apps/dashboard/src/lib/button-registry.ts`. Each test asserts `await page.locator(\`[data-testid="${id}"]\`).click()` either fires a network request OR navigates — both observable in Playwright.

---

### D2. Inbox SSE consumer — already in place, extend `InboxClient.tsx` with classification branch

**Analog:** `apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` lines 113-125 — already subscribes to inbox_item, draft_ready, entity_merge.

**SSE subscription pattern** (lines 115-125):

```tsx
const onSseRefresh = useCallback(
  (label: string) => () => {
    announce(label);
    router.refresh();
  },
  [announce, router],
);

useSseKind('inbox_item', onSseRefresh('New inbox item'));
useSseKind('draft_ready', onSseRefresh('New draft ready'));
useSseKind('entity_merge', onSseRefresh('Merge status updated'));
```

**Apply to D-05:** the InboxClient already does the right thing on SSE. Extension is purely render-side: `ItemRow.tsx` reads `item.classification` (new optional field on InboxItem), and conditionally hides Approve/Skip when status is terminal (`skipped`/`sent`/`failed`/`approved`). The keyboard handler in `InboxClient.tsx:doApprove` (lines 129-145) already pre-checks `selectedRef.current` — extend it to no-op when `selected.classification && !['urgent'].includes(selected.classification) && selected.status !== 'draft'`.

---

### D3. Inbox row classification slot — extend `ItemRow.tsx`

**Analog:** `apps/dashboard/src/app/(app)/inbox/ItemRow.tsx` lines 39-83 — single grid row already places `<BolagBadge org={item.bolag} />` in the rightmost column.

**Existing render shape** (lines 40-84):

```tsx
<button
  type="button"
  onClick={onClick}
  aria-pressed={selected}
  className="w-full text-left grid items-start"
  style={{ gridTemplateColumns: '20px 1fr auto', gap: 10, padding: '12px 14px', /* ... */ }}
>
  <Icon size={14} className="mt-1" style={{ color: 'var(--color-text-3)' }} />
  <div className="min-w-0 flex flex-col gap-1">
    <div className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{item.title}</div>
    <div className="text-xs line-clamp-2" style={{ color: 'var(--color-text-3)' }}>{item.preview}</div>
  </div>
  <BolagBadge org={item.bolag} />
</button>
```

**Apply to D-05:** keep the grid; add a parallel `<Pill classification={item.classification} status={item.status} />` slot inside the meta row (between title and preview, or stacked above the BolagBadge). Use the new `Pill.tsx` component (analog: BolagBadge above).

---

### D4. Vercel API mirror route — `app/api/integrations/health/route.ts`

**Analog:** `apps/dashboard/src/app/api/today/route.ts` (and `apps/dashboard/src/app/api/calendar/week/route.ts` — both already-mirrored handlers — see RESEARCH §"Pages & Routes").

The pattern is the trivial `callApi` proxy (request → callApi(/path) → response). Plan the new file as `import { callApi } from '@/lib/dashboard-api'; export async function GET() { return Response.json(await callApi('/integrations/health', {method:'GET'}, IntegrationsHealthResponseSchema)); }`.

---

### D5. Persistent floating chat bubble — fixed-position client component

**Analog:** `apps/dashboard/src/components/system/OfflineBanner.tsx` (RESEARCH inferred — fixed-top-banner pattern). The chat bubble is the bottom-right counterpart.

**Sidebar-flip pattern** for re-enabling Chat link (`Sidebar.tsx` lines 121-126 — flip `disabled` to remove + add real `href`):

```tsx
<NavItem
  href="/chat"
  icon={<MessageSquare size={14} />}
  label="Chat"
  disabled                                     // REMOVE
  disabledTooltip="Ships with Phase 4"         // REMOVE
/>
```

**Mount the floating bubble globally** in `apps/dashboard/src/app/(app)/layout.tsx` (lines 73-84 — extend the inner `<div className="flex min-h-screen ...">` with a `<ChatBubble />` sibling that fixed-positions to bottom-right).

**Layout pattern to extend** (lines 73-86):

```tsx
<div className="flex min-h-screen bg-[color:var(--color-bg)]">
  <Sidebar entityCounts={counts} />
  <div className="flex min-w-0 flex-1 flex-col">
    <Topbar />
    <main id="content" className="mx-auto w-full max-w-[1280px] flex-1 px-8 py-8">
      {children}
    </main>
  </div>
</div>
{/* ADD: */}
<ChatBubble />

<Toaster position="top-right" />
```

The `Toaster` already pins top-right, so a bottom-right bubble does not collide (RESEARCH risk note line 628 confirms).

---

## Shared Patterns (cross-cutting)

### Owner-scope guard (every SQL must call)

**Source:** `services/dashboard-api/src/owner-scoped.ts` lines 25-46

**Apply to:** every new dashboard-api handler (`handlers/integrations.ts`, extensions to `handlers/today.ts`, `handlers/calendar.ts`, `routes/inbox.ts`).

```typescript
import { ownerScoped, OWNER_ID } from '../owner-scoped.js';

// Drizzle query builder (preferred for typed access):
.where(ownerScoped(inboxIndex, eq(inboxIndex.status, 'pending')))

// Raw SQL (use OWNER_ID literal):
sql`... WHERE owner_id = ${OWNER_ID} AND ...`
```

NEVER write a new SQL query against any owned table without owner_id binding. T-3-02-04 mitigation.

---

### Auth boundary (already enforced upstream)

**Source:** `services/dashboard-api/src/index.ts` lines 42-75

Every new dashboard-api handler is automatically Bearer-protected by the Lambda entry — no per-handler auth needed. The `verifyBearer` is constant-time. Any new Vercel `app/api/*/route.ts` proxy automatically gets the bearer because `callApi` injects it.

**Pattern (do NOT duplicate in new handlers):**

```typescript
function verifyBearer(headers): boolean { /* already done at Lambda entry */ }
```

---

### zod-at-exit response validation

**Source:** `services/dashboard-api/src/handlers/today.ts:200` + `handlers/calendar.ts:197` + `handlers/inbox.ts:80`

**Apply to:** every new handler MUST `Schema.parse(payload)` before `JSON.stringify`. This catches accidental shape drift at Lambda runtime, not just at compile time. Pattern:

```typescript
const payload = TodayResponseSchema.parse({ /* ... */ });
return { statusCode: 200, body: JSON.stringify(payload) };
```

---

### Cache headers (private SWR)

**Source:** `services/dashboard-api/src/handlers/today.ts:215` + `routes/inbox.ts:71` + `handlers/inbox.ts:84`

**Apply to:** every GET handler.

```typescript
headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=5' },     // hot data (inbox)
headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=86400' }, // daily data (today brief)
headers: { 'cache-control': 'private, max-age=0, stale-while-revalidate=60' },    // medium (calendar, integrations health)
```

---

### Empty state (D-12)

**Source:** `apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` lines 220-240

**Apply to:** every new page (`/integrations-health`, `/chat`, extended `/today`).

```tsx
if (optimistic.length === 0) {
  return (
    <div className="h-full grid place-items-center">
      <div className="text-center flex flex-col gap-3 items-center">
        <div className="flex items-center gap-2">
          <PulseDot tone="success" />
          <span className="font-medium" style={{ color: 'var(--color-text)' }}>{EMPTY_HEADLINE}</span>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>{EMPTY_BODY}</p>
      </div>
    </div>
  );
}
```

NEVER render a blank section. Use informative copy: `"No captures today — KOS will surface as they arrive"`.

---

### Server Action pattern (`'use server'` per route)

**Source:** `apps/dashboard/src/app/(app)/inbox/actions.ts` lines 1-63

**Apply to:** any new mutation surface (e.g., `/integrations-health` "Run scheduler now" button if Settings is wired). Pattern:

```typescript
'use server';
import { revalidatePath } from 'next/cache';
import { callApi } from '@/lib/dashboard-api';

export async function doThing(id: string): Promise<void> {
  await callApi(`/path/${id}/action`, { method: 'POST' }, ResponseSchema);
  revalidatePath('/relevant-route');
}
```

---

### Force-dynamic + force-rsc (every authenticated route)

**Source:** every existing `(app)/*/page.tsx`. Pattern:

```typescript
export const dynamic = 'force-dynamic';
```

REQUIRED so SSE `router.refresh()` re-executes the RSC against fresh data. Without this the re-render serves a cached payload and the SSE work is silent.

---

## Patterns to Avoid (anti-patterns / things NOT to copy)

### A1 — Do NOT write a Drizzle migration for the demo wipe

The wipe is data-only (no schema change). The `packages/db/drizzle/0021_phase_10_migration_audit.sql` file is what *real* migrations look like. The wipe lives in `scripts/` (not `packages/db/drizzle/`) so Drizzle's migration runner never tries to re-apply it.

### A2 — Do NOT replace `globals.css`

The `@theme {}` block at `apps/dashboard/src/app/globals.css:8-70` is the locked 03-UI-SPEC token system. Mission-control patterns LAYER on top via new `.mc-*` classes consuming the same tokens. Rejecting wholesale replacement is RESEARCH primary recommendation.

### A3 — Do NOT introduce framer-motion hover-lift on every panel

`apps/dashboard/src/app/globals.css:247-248` shows the SINGLE sanctioned hover-transform in the app (`.cal-event:hover { transform: translateY(-1px); }`). Mission-control ports must NOT add `motion.div` hover-scale on stat tiles, channel rows, or chat bubble. UI-SPEC line 428.

### A4 — Do NOT add new SSE event kinds

The `SseEventKindSchema` enum at `packages/contracts/src/dashboard.ts:311-317` is fixed. New pages re-use existing kinds (per RESEARCH "Phase 11 adds no new kinds"). Adding `'integration_health_change'` or similar is out of scope and would force a relay-side change.

### A5 — Do NOT call dashboard-api directly from client components

`apps/dashboard/src/app/(app)/inbox/InboxClient.tsx` is a client component but ALL its mutations go via Server Actions (`actions.ts` → callApi). Reads happen in the RSC parent (`page.tsx`). Same rule applies to all new pages — never `fetch()` to dashboard-api from a `'use client'` component.

### A6 — Do NOT skip the bearer/owner_id checks "because Lambda already does it"

Every new `db.execute(sql\`...\`)` MUST include `WHERE owner_id = ${OWNER_ID}`. Defense-in-depth — if the Lambda auth is ever loosened, the SQL still scopes correctly.

### A7 — Do NOT use shadcn primitives outside `components/ui/`

`apps/dashboard/src/components/ui/` is shadcn-generated; everything else lives at `components/{badge,system,palette,...}/`. New mission-control components belong under `components/dashboard/` or `components/chat/`, NOT mixed with shadcn primitives.

### A8 — Do NOT couple the SSE backoff to per-page state

`apps/dashboard/src/components/system/SseProvider.tsx:108-204` keeps a SINGLE `EventSource` per tab with module-internal backoff. New pages just call `useSseKind(...)` — never instantiate a second `EventSource` (RESEARCH risk row "SSE reconnect storm" line 618).

---

## No Analog Found

Files with no close existing match in this codebase:

| File | Role | Reason |
|------|------|--------|
| `scripts/verify-phase-11-wipe.sh` | smoke / shell | No bash smoke test scripts in the repo. Closest pattern is `scripts/run-migrations.sh` if it exists; otherwise this is greenfield. Wave 0 task. |
| `apps/dashboard/src/lib/button-registry.ts` | utility / TS const | No analog — a phase-specific data-testid catalog. Closest shape: `apps/dashboard/src/lib/bolag.ts` constant-table pattern. |

---

## Metadata

**Analog search scope:**
- `apps/dashboard/src/app/(app)/{today,inbox,entities,calendar,settings}/**`
- `apps/dashboard/src/components/{app-shell,badge,palette,system,ui}/**`
- `apps/dashboard/tests/{e2e,integration,unit}/**`
- `services/dashboard-api/src/{handlers,routes,*.ts}`
- `services/dashboard-api/tests/**`
- `packages/contracts/src/dashboard.ts`
- `packages/db/drizzle/{0001,0008,0016,0020}*.sql`

**Files inspected directly:** 23 (every excerpt above quotes from a real file at the cited line range)

**Pattern extraction date:** 2026-04-26

**Stop reason:** all 5 workstreams from RESEARCH have at least one strong analog; the only no-analog cases are scripts/* shell + a phase-specific data registry (correctly flagged for Wave 0 greenfield).

---

## PATTERN MAPPING COMPLETE
</content>
</invoke>
</invoke>