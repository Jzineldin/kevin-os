---
phase: quick
plan: 260424-pxt
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/dashboard/src/app/(app)/entities/page.tsx
autonomous: true
requirements: [paper-cut-1-sidebar-404]
tags: [dashboard, ui, next-app-router, paper-cut]

must_haves:
  truths:
    - "Clicking 'People' in the sidebar lands on /entities?type=person with HTTP 200 (not 404)"
    - "Clicking 'Projects' in the sidebar lands on /entities?type=project with HTTP 200 (not 404)"
    - "The rendered page shows a list of entities filtered by the ?type= query param"
    - "Each entity row links to /entities/<id> (the existing dossier page)"
    - "Missing or invalid ?type= param renders a non-crashing fallback (all entities grouped or a chooser)"
  artifacts:
    - path: "apps/dashboard/src/app/(app)/entities/page.tsx"
      provides: "RSC route handler for /entities that renders a filtered entity list"
      contains: "export default async function"
  key_links:
    - from: "apps/dashboard/src/app/(app)/entities/page.tsx"
      to: "getPaletteEntities() in @/components/palette/palette-root"
      via: "server-side import + await (SigV4-safe)"
      pattern: "getPaletteEntities"
    - from: "apps/dashboard/src/app/(app)/entities/page.tsx"
      to: "/entities/[id] dossier"
      via: "next/link href=`/entities/${entity.id}`"
      pattern: "entities/\\$\\{.*\\.id\\}"
---

<objective>
Fix paper cut #1 from the 2026-04-24 v2 handoff: the dashboard sidebar's "People" and "Projects" links 404 because `apps/dashboard/src/app/(app)/entities/page.tsx` does not exist. Create that single page as an RSC that reuses the existing `getPaletteEntities()` server helper (same loader the command palette uses — hits dashboard-api `/entities/list` via SigV4) and renders a filtered list.

Purpose: Eliminate the broken sidebar clicks. Kevin clicks sidebar → sees entities → clicks an entity → lands on the existing `/entities/[id]` dossier.

Output: One new file — `apps/dashboard/src/app/(app)/entities/page.tsx`. No schema changes. No new dependencies. No API changes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@apps/dashboard/src/components/app-shell/Sidebar.tsx
@apps/dashboard/src/app/(app)/layout.tsx
@apps/dashboard/src/app/(app)/inbox/page.tsx
@apps/dashboard/src/app/(app)/today/page.tsx
@apps/dashboard/src/app/api/palette-entities/route.ts
@apps/dashboard/src/components/palette/palette-root.ts
@apps/dashboard/src/app/(app)/entities/[id]/page.tsx

<interfaces>
<!-- Extracted from apps/dashboard/src/components/palette/palette-root.ts. Executor should
     import and use `getPaletteEntities` directly — no need to explore further. -->

From apps/dashboard/src/components/palette/palette-root.ts:
```typescript
import { z } from 'zod';

export const PaletteEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),         // e.g. "person" | "project" | "company" | "document"
  bolag: z.string().nullable(),
});

export type PaletteEntity = z.infer<typeof PaletteEntitySchema>;

export async function getPaletteEntities(): Promise<PaletteEntity[]>;
// Returns [] on fetch failure (endpoint-may-not-exist-yet pattern). Safe to call
// from a Server Component; wraps callApi() which uses SigV4 server-only creds.
```

From apps/dashboard/src/app/(app)/layout.tsx (wrapping layout — already applied):
```typescript
// <main> already provides:
//   - max-w-[1280px] centered container
//   - px-8 py-8 padding
// So this page's root element should NOT re-wrap in another max-width container.
// Start with a heading + list directly.
```

From apps/dashboard/src/components/app-shell/Sidebar.tsx (links that must resolve):
```
/entities?type=person
/entities?type=project
```

Existing sibling-route convention (from inbox/page.tsx and today/page.tsx):
```typescript
export const dynamic = 'force-dynamic';

export default async function FooPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  // ...
}
```

Existing entity detail page is at `/entities/[id]` — rows should link to `/entities/${entity.id}`.
</interfaces>

<sidebar_conventions>
- Tailwind v4 with CSS variables: text-[color:var(--color-text)], text-[color:var(--color-text-2)], text-[color:var(--color-text-4)], bg-[color:var(--color-surface-1)], border-[color:var(--color-border)], hover:bg-[color:var(--color-surface-hover)]
- Typography: page titles use text-[20px] or similar in other views; uppercase section labels use text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]
- Row hover: rounded-md px-[10px] py-[6px] text-[13px] hover:bg-[color:var(--color-surface-hover)]
- Icons from lucide-react (Users for person, Folder for project) — already imported in Sidebar.tsx
- No new shadcn primitives needed; plain <a>/next-link + Tailwind classes match the existing sidebar + inbox row aesthetic
</sidebar_conventions>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create /entities list page RSC</name>
  <files>apps/dashboard/src/app/(app)/entities/page.tsx</files>
  <action>
Create a single Next.js App Router RSC at `apps/dashboard/src/app/(app)/entities/page.tsx` that:

1. **Top-of-file docblock** — mirror the style of sibling `page.tsx` files (inbox/today). Call out: (a) this resolves paper cut #1 from the 2026-04-24 v2 handoff, (b) the sidebar has two hard-coded links (`/entities?type=person` and `/entities?type=project`), (c) reuses the existing `getPaletteEntities()` loader to avoid introducing a second entity-list code path.

2. **Imports:**
   ```typescript
   import Link from 'next/link';
   import { Users, Folder, Building2, FileText, HelpCircle } from 'lucide-react';
   import {
     getPaletteEntities,
     type PaletteEntity,
   } from '@/components/palette/palette-root';
   ```
   Do NOT add any new dependencies. Do NOT import callApi directly — `getPaletteEntities` already wraps it with the proper try/catch + empty-array fallback (same "no crying wolf" pattern the layout's `fetchSidebarCounts` uses).

3. **Page config:**
   ```typescript
   export const dynamic = 'force-dynamic';
   ```
   (matches inbox/today/entities-[id] convention — SSE-driven counts must not cache.)

4. **Signature — Next 15+ async searchParams:**
   ```typescript
   export default async function EntitiesPage({
     searchParams,
   }: {
     searchParams: Promise<{ type?: string }>;
   }) {
     const { type } = await searchParams;
     // ...
   }
   ```

5. **Param validation (graceful):** Accept `type` ∈ `{'person','project','company','document'}`. Anything else (missing, empty, typo, SQLi attempt) → set `filterType = null` and render the ALL view. Do not throw, do not 404, do not redirect.

6. **Data fetch:**
   ```typescript
   const entities = await getPaletteEntities();
   // `getPaletteEntities` already returns [] on failure; no try/catch needed here.
   const filtered = filterType
     ? entities.filter((e) => e.type === filterType)
     : entities;
   ```

7. **Render — server-rendered list, no client component:**

   Page structure:
   - Outer: `<div className="flex flex-col gap-6">` (layout.tsx already provides max-w + padding)
   - Header: `<h1 className="text-[20px] font-semibold text-[color:var(--color-text)]">{title}</h1>` where `title` is `"People"` if type=person, `"Projects"` if type=project, `"Companies"` if type=company, `"Documents"` if type=document, else `"Entities"`.
   - Subheading below h1: `<p className="text-[13px] text-[color:var(--color-text-3)]">{filtered.length} {filtered.length === 1 ? 'entity' : 'entities'}</p>`
   - Filter chips row (only shown when filterType is null, to help navigate): four `<Link>` chips to `/entities?type=person|project|company|document`. Each chip: `inline-flex items-center gap-2 rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-[12px] text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)]`. Include small lucide icon.
   - Empty state (filtered.length === 0):
     ```tsx
     <div className="rounded-md border border-[color:var(--color-border)] px-4 py-6 text-[13px] text-[color:var(--color-text-3)]">
       No {title.toLowerCase()} yet.
     </div>
     ```
   - List (filtered.length > 0):
     ```tsx
     <ul className="flex flex-col gap-1">
       {filtered.map((e) => (
         <li key={e.id}>
           <Link
             href={`/entities/${e.id}`}
             className="flex items-center gap-3 rounded-md px-[10px] py-[8px] text-[13px] text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
           >
             <EntityIcon type={e.type} />
             <span className="flex-1 truncate text-[color:var(--color-text)]">{e.name}</span>
             {e.bolag && (
               <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
                 {e.bolag}
               </span>
             )}
             <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-text-4)]">
               {e.type}
             </span>
           </Link>
         </li>
       ))}
     </ul>
     ```
   - `EntityIcon` is a local const function in the same file mapping `type → lucide icon` (person→Users, project→Folder, company→Building2, document→FileText, else→HelpCircle), all `size={14}` with `className="text-[color:var(--color-text-3)]"`.

8. **Sort:** Before rendering, `filtered.sort((a, b) => a.name.localeCompare(b.name, 'sv'))` — Swedish-first locale per CLAUDE.md bilingual constraint. Keep deterministic output.

9. **No client-side state, no hooks, no 'use client'.** Server render only. Paper cut fix, not a feature.

**Why no SSE / no refresh loop:** This is a list the user explicitly navigates to. Entity additions are rare events Kevin is aware of (he just captured them). Adding SSE here would duplicate infrastructure from the palette without a concrete trigger event yet. If an `entity_added` SSE kind is defined later, a follow-up quick task can add `router.refresh()` — not this plan's scope.

**Why reuse `getPaletteEntities`:** Single source of truth — the command palette already shows Kevin this same list, fetched via this exact helper. If the dashboard-api `/entities/list` endpoint changes shape, both surfaces update together. Do NOT fetch directly with `callApi('/entities/list', …)` — bypasses the empty-array fallback and duplicates the Zod schema.

**Do NOT add pagination.** Endpoint returns the full list; palette already handles the full set in memory. At KOS's single-user scale (a few hundred entities max) this is fine.
  </action>
  <verify>
    <automated>cd apps/dashboard && pnpm tsc --noEmit 2>&1 | grep -E "src/app/\(app\)/entities/page\.tsx" ; test $? -ne 0 && echo PASS-TSC-CLEAN</automated>
    <automated>cd apps/dashboard && pnpm next lint --file src/app/\(app\)/entities/page.tsx 2>&1 | tail -5</automated>
    <automated>cd apps/dashboard && pnpm next build 2>&1 | grep -E "(entities|Error)" | head -20</automated>
    <manual>In a dev server (pnpm dev), visit http://localhost:3000/entities?type=person and confirm: (a) HTTP 200, (b) a list renders (empty state OK), (c) each row links to /entities/&lt;uuid&gt;, (d) sidebar link matches. Repeat for ?type=project, ?type=, and ?type=garbage.</manual>
  </verify>
  <done>
File exists at `apps/dashboard/src/app/(app)/entities/page.tsx`. TypeScript compiles clean. `pnpm next build` succeeds for the dashboard app with `/entities` listed as a route. Manual dev-server check: `/entities?type=person`, `/entities?type=project`, `/entities` (no param), and `/entities?type=garbage` all return HTTP 200 and render a page (not a 404, not a crash). Clicking a row navigates to `/entities/&lt;id&gt;`.
  </done>
</task>

</tasks>

<verification>
**Route existence:**
```bash
cd apps/dashboard && pnpm next build 2>&1 | grep -E "^○|^●|^λ" | grep entities
# Expected output includes a line for /entities (not just /entities/[id])
```

**Sidebar link integrity (no change expected, just confirm pre-existing):**
```bash
grep -nE 'href="/entities\?type=(person|project)"' apps/dashboard/src/components/app-shell/Sidebar.tsx
# Expected: 2 matches (lines ~135 and ~141)
```

**Manual smoke test (operator, post-deploy):**
1. Load the dashboard.
2. Click "People" in the sidebar → expect a list of people.
3. Click "Projects" in the sidebar → expect a list of projects.
4. Click any entity row → expect `/entities/<id>` dossier to load.
5. Manually hit `/entities` with no query param → expect all entities grouped / chooser chips.
6. Manually hit `/entities?type=garbage` → expect graceful fallback (same as no param), not a 404 or exception.
</verification>

<success_criteria>
- [ ] `apps/dashboard/src/app/(app)/entities/page.tsx` exists and is a server component (no `'use client'`).
- [ ] Sidebar links `/entities?type=person` and `/entities?type=project` return HTTP 200 in production.
- [ ] Page reuses `getPaletteEntities()` — no direct `callApi('/entities/list', …)` call duplicated.
- [ ] Rows link to `/entities/${id}` (existing dossier route).
- [ ] Missing/invalid `?type=` renders the ALL view with filter chips; never 404s, never crashes.
- [ ] No new npm dependencies added (`git diff package.json` is empty).
- [ ] `pnpm tsc --noEmit` clean; `pnpm next build` succeeds.
- [ ] Swedish-locale alphabetical sort applied (`localeCompare(…, 'sv')`).
</success_criteria>

<output>
After completion, create `.planning/quick/260424-pxt-fix-dashboard-sidebar-404-create-apps-da/260424-pxt-SUMMARY.md` with:
- What shipped (the new page.tsx)
- Any deviations from this plan
- Commit hash
- Screenshot or curl-output evidence (optional — visual confirmation that sidebar → list → dossier works end-to-end)
- Updates to STATE.md "Quick Tasks Completed" table
</output>
