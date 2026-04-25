---
phase: 03
plan: 01
subsystem: dashboard-mvp-wave-1-primitives
tags: [dashboard, rds, drizzle, migrations, listen-notify, shadcn, tailwind-v4, eslint, design-tokens]
dependency_graph:
  requires:
    - "03-00 (Next 15.5 + Tailwind v4 @theme + contracts + service scaffolds)"
  provides:
    - "packages/db migrations 0007-0010 (entity_merge_audit + inbox_index + 4 NOTIFY triggers + timeline indexes)"
    - "Drizzle objects entityMergeAudit + inboxIndex exported from @kos/db/schema"
    - "apps/dashboard shadcn/ui init (14 primitives) with @theme tokens preserved"
    - "apps/dashboard/src/lib/bolag.ts (getBolagClass, getBolagToken, BOLAG_MAP)"
    - ".badge / .bolag-tf / .bolag-ob / .bolag-pe utility classes in globals.css"
    - "apps/dashboard eslint.config.mjs flat config with hex/XSS/Edge guards"
  affects:
    - packages/db/drizzle
    - packages/db/src/schema.ts
    - apps/dashboard/package.json (deps + lint script)
    - apps/dashboard/src/app/globals.css
tech_stack:
  added:
    - "shadcn@4.4.0 (CLI + initialized components)"
    - "@radix-ui/* (transitive via shadcn primitives)"
    - "cmdk@^1.1.1 (command palette engine)"
    - "lucide-react@^1.8.0 (icon set)"
    - "class-variance-authority@^0.7.1"
    - "clsx@^2.1.1 + tailwind-merge@^3.5.0"
    - "sonner@^2.0.7 (toast primitive)"
    - "tw-animate-css@^1.4.0 (shadcn motion helpers)"
    - "next-themes@^0.4.6 (shadcn-init transitive; not used in Phase 3)"
    - "eslint@9 + eslint-config-next@15.5.4 + typescript-eslint + @eslint/eslintrc (FlatCompat)"
  patterns:
    - "Four distinct PL/pgSQL NOTIFY functions (per RESEARCH §11 caveat; TG_ARGV+CASE-in-EXECUTE is invalid)"
    - "Pointer-only pg_notify payloads (kind + id + ts [+ entity_id]) under 8KB NOTIFY cap per D-25"
    - "Partial indexes for hot paths (inbox_index_pending WHERE status='pending'; agent_runs_by_entity_jsonb WHERE output_json ? 'entity_id')"
    - "Flat ESLint config with no-restricted-syntax selectors for design-token enforcement"
    - "shadcn primitives ignored from our lint rules (upstream-authored; our own views are linted)"
key_files:
  created:
    - packages/db/drizzle/0007_entity_merge_audit.sql
    - packages/db/drizzle/0008_inbox_index.sql
    - packages/db/drizzle/0009_listen_notify_triggers.sql
    - packages/db/drizzle/0010_entity_timeline_indexes.sql
    - apps/dashboard/components.json
    - apps/dashboard/eslint.config.mjs
    - apps/dashboard/src/components/ui/avatar.tsx
    - apps/dashboard/src/components/ui/button.tsx
    - apps/dashboard/src/components/ui/card.tsx
    - apps/dashboard/src/components/ui/command.tsx
    - apps/dashboard/src/components/ui/dialog.tsx
    - apps/dashboard/src/components/ui/dropdown-menu.tsx
    - apps/dashboard/src/components/ui/input-group.tsx
    - apps/dashboard/src/components/ui/input.tsx
    - apps/dashboard/src/components/ui/kbd.tsx
    - apps/dashboard/src/components/ui/scroll-area.tsx
    - apps/dashboard/src/components/ui/separator.tsx
    - apps/dashboard/src/components/ui/sonner.tsx
    - apps/dashboard/src/components/ui/tabs.tsx
    - apps/dashboard/src/components/ui/textarea.tsx
    - apps/dashboard/src/components/ui/tooltip.tsx
    - apps/dashboard/src/lib/bolag.ts
    - apps/dashboard/src/lib/utils.ts
    - apps/dashboard/tests/unit/bolag.test.ts
  modified:
    - packages/db/src/schema.ts
    - apps/dashboard/package.json
    - apps/dashboard/src/app/globals.css
    - pnpm-lock.yaml
decisions:
  - "Keep existing KEVIN_OWNER_ID (7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c) as the owner_id SQL default in new migrations — plan suggested a different literal but it would have broken consistency with 0001-0006 and packages/db/src/owner.ts. Kevin's single canonical UUID stays one value repo-wide."
  - "Write SQL migrations as the source of truth; Drizzle table objects in schema.ts are added for type-safe queries from dashboard-api but the CHECK constraints live in SQL only (Drizzle does not model CHECK constraints at the column level as of 0.36)."
  - "Skip `skeleton` component install explicitly — banned per 03-UI-SPEC.md §Avoids + D-12 (single pulse-dot motion primitive replaces all skeleton screens)."
  - "Migrate dashboard lint from `next lint` to direct `eslint .` — Next 15.5 deprecates `next lint` and the built-in config referenced `no-unassigned-vars` which doesn't exist in ESLint 9.14."
  - "Ignore src/components/ui/** from our ESLint rules — shadcn primitives are upstream-authored; our Wave 1+ views that consume them ARE linted."
  - "Drop @eslint/js v10 from the config (recommended.rules references `no-unassigned-vars` absent in ESLint 9.14). typescript-eslint's recommended config provides the JS baseline we need."
metrics:
  duration: "≈25m"
  tasks_committed: 2
  files_created: 22
  files_modified: 4
  completed_date: "2026-04-23"
requirements_addressed: [ENT-07, ENT-08, UI-04, UI-05]
---

# Phase 3 Plan 03-01: RDS schema + shadcn primitives Summary

**One-liner:** Lands the four RDS migrations Phase 3 needs (entity_merge_audit + inbox_index + four distinct pg_notify triggers + timeline indexes), extends @kos/db Drizzle schema to expose the two new tables as type-safe objects, initializes shadcn/ui in apps/dashboard with the 14 UI primitives, and wires bolag design-token helpers + an ESLint flat config that bans raw hex in JSX, `dangerouslySetInnerHTML`, and Node-only packages in Edge middleware.

## What shipped

### Task 1 (commit `42c7f4d`) — Migrations 0007-0010 + Drizzle schema

**0007_entity_merge_audit.sql** — ENT-07 state machine for manual entity merges (D-27..D-29):
- `merge_id TEXT PRIMARY KEY` (ULID string — sortable audit trail).
- `source_entity_id` + `target_entity_id` → FK into `entity_index(id)`.
- `state` CHECK-constrained to 11 values: `initiated`, `notion_relations_copied`, `notion_archived`, `rds_updated`, `complete`, `failed_at_initiated`, `failed_at_notion_relations_copied`, `failed_at_notion_archived`, `failed_at_rds_updated`, `cancelled`, `reverted`.
- `diff JSONB NOT NULL`, `error_message TEXT`, `notion_archived_at TIMESTAMPTZ`, `rds_updated_at TIMESTAMPTZ`, timestamps at each step.
- `owner_id UUID NOT NULL DEFAULT '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'::uuid` (forward-compat per STATE.md #13; matches existing 0001-0006 literal).
- 3 indexes: `(state, created_at DESC)`, `(source_entity_id)`, `(owner_id, created_at DESC)`.

**0008_inbox_index.sql** — UI-04 RDS mirror of KOS Inbox Notion DB (per RESEARCH §9 recommendation (b)):
- `id TEXT PRIMARY KEY` (matches Notion page id verbatim → idempotent upserts).
- CHECK constraints on `kind` (draft_reply | entity_routing | new_entity | merge_resume), `bolag` (tale-forge | outbehaving | personal | NULL), `status` (pending | approved | skipped | rejected | archived).
- `entity_id UUID → entity_index(id)`, `merge_id TEXT → entity_merge_audit(merge_id)`, `payload JSONB DEFAULT '{}'::jsonb`.
- 3 indexes: partial `(owner_id, created_at DESC) WHERE status='pending'` (hot path for Inbox view), `(entity_id) WHERE entity_id IS NOT NULL`, `(merge_id) WHERE merge_id IS NOT NULL`.

**0009_listen_notify_triggers.sql** — Four distinct PL/pgSQL functions per RESEARCH §11 caveat (TG_ARGV + CASE-in-EXECUTE is invalid PL/pgSQL):
- `notify_inbox_item()` → kind='inbox_item' on INSERT into inbox_index.
- `notify_entity_merge()` → kind='entity_merge' (with entity_id) only when state flips from `!= 'complete'` to `'complete'`.
- `notify_timeline_event()` → kind='timeline_event' (with entity_id) on INSERT into mention_events.
- `notify_agent_run()` → kind='capture_ack' for agent_name='voice-capture', kind='draft_ready' for agent_name IN ('email-triage-draft','email-triage'); both only when status='ok'.
- All payloads are pointer-only (kind + id + ts [+ entity_id]) per D-25, well under the 8KB NOTIFY cap.
- Triggers: `trg_inbox_notify`, `trg_entity_merge_notify`, `trg_mention_notify`, `trg_agent_run_notify`. Idempotent via DROP TRIGGER IF EXISTS before CREATE.

**0010_entity_timeline_indexes.sql** — Per-entity dossier UNION ALL query performance (UI-02, ENT-08 < 500ms budget):
- `CREATE INDEX mention_events_by_entity_time_desc ON mention_events(entity_id, occurred_at DESC, id DESC) WHERE owner_id IS NOT NULL` — stable keyset pagination.
- `CREATE INDEX agent_runs_by_entity_jsonb ON agent_runs(((output_json->>'entity_id')::uuid), started_at DESC) WHERE output_json ? 'entity_id'` — expression index restricted to rows that carry the entity_id key.

**packages/db/src/schema.ts** — `entityMergeAudit` + `inboxIndex` Drizzle objects added, using `text` for `mergeId`, `text` for `state` (CHECK lives in SQL), and sensible default/unique/FK declarations that mirror the SQL migrations. Exported via the existing `@kos/db` barrel.

### Task 3 (commit `ed825f9`) — shadcn/ui init + 14 primitives + bolag + ESLint

**shadcn init** via `pnpm dlx shadcn@latest init --yes --defaults --base radix --silent`:
- `components.json` pinned with `style: "radix-nova"`, `rsc: true`, `tsx: true`, `tailwind.cssVariables: true`, all alias paths match tsconfig (`@/components`, `@/lib/utils`, `@/components/ui`).
- `src/lib/utils.ts` generated with `cn()` helper (`clsx` + `twMerge`).
- `globals.css` preserved the `@theme` token block verbatim (lines 7-70). shadcn appended a neutral preset (`@theme inline`, `:root`, `.dark`) below our block — our explicit `--color-*` tokens win at the component layer in Wave 1+ views.

**14 UI primitives installed** in `src/components/ui/`:
  - `button`, `card`, `dialog`, `command`, `input`, `textarea`, `tabs`, `separator`, `scroll-area`, `sonner`, `avatar`, `tooltip`, `dropdown-menu` — all via `shadcn@latest add`.
  - `kbd` — hand-authored (shadcn does not ship a `kbd` component in its official registry). Uses `React.forwardRef` + `cn()` convention matching the rest. Styled against our `--color-surface-2` / `--color-border` / `--color-text-3` / `--radius-sm` / `--text-xs` / `--font-mono` tokens.
  - `input-group` — transitive install pulled in by `command` (15 `.tsx` total in `ui/`).
  - `skeleton` intentionally NOT installed — banned per 03-UI-SPEC.md §Avoids (D-12 single pulse-dot replaces all skeleton screens).

**src/lib/bolag.ts** — Three exports:
- `BOLAG_MAP`: `'tale forge' | 'tale-forge' | 'outbehaving' | 'personal'` → `bolag-tf | bolag-ob | bolag-pe`.
- `getBolagClass(org)`: case-insensitive, accepts hyphen + space variants, returns the Tailwind class.
- `getBolagToken(org)`: returns the canonical token name (`tale-forge | outbehaving | personal`) matching `--color-<token>` in globals.css.
- Null / undefined / empty / unknown → `bolag-pe` (Personal fallback).
- 7 Vitest cases at `tests/unit/bolag.test.ts`, all green.

**globals.css** appended `.badge` + `.bolag-{tf,ob,pe}` utility classes using `color-mix(in srgb, var(--color-<token>) {6|18|100}%, transparent)` so each tint (background/border/foreground) derives from a single token. Matches TFOS-ui.html `.badge.bolag-*` 1:1.

**apps/dashboard/eslint.config.mjs** (flat config) bans:
- Raw hex in JSX `className` (Literal + TemplateElement selectors) → enforces design-token-only colors (03-UI-SPEC Fidelity Rule 4).
- Inline `style={{ backgroundColor: '…' }}` — use Tailwind classes or CSS variables.
- `dangerouslySetInnerHTML` → XSS mitigation for Notion rich-text (RESEARCH §16).
- `import { db } from '@kos/db'` in Vercel code → Drizzle client cannot reach RDS from Vercel (VPC-only); must go through dashboard-api via SigV4 fetch.
- `@kos/db`, `pg`, `@aws-sdk/*` imports in `src/middleware.ts` → middleware runs on Edge runtime (RESEARCH P-01).
- `src/components/ui/**` excluded from our rules — shadcn-authored primitives; Wave 1+ views that consume them ARE linted.
- Smoke-test confirmed: a test file with `className="bg-[#ff00aa]"` + `dangerouslySetInnerHTML` produces 2 errors.

## Verification results

| Command | Result |
| --- | --- |
| `pnpm --filter @kos/db typecheck` | clean (TS 5.6.3) |
| `pnpm --filter @kos/dashboard typecheck` | clean |
| `pnpm --filter @kos/dashboard lint` | 0 errors, 2 trivial warnings (anonymous default exports in config files) |
| `pnpm --filter @kos/dashboard exec vitest run tests/unit/bolag.test.ts` | 7 passed / 7 total |
| `pnpm --filter @kos/dashboard build` | clean — 4 static routes, 102 kB first-load JS |
| `ls packages/db/drizzle/0007..0010 \| wc -l` | 4 |
| `grep -c "CREATE OR REPLACE FUNCTION notify_" 0009_listen_notify_triggers.sql` | 4 |
| `grep -c "pg_notify('kos_output'" 0009_listen_notify_triggers.sql` | 4 |
| `grep -c "CREATE TRIGGER trg_" 0009_listen_notify_triggers.sql` | 4 |
| `ls apps/dashboard/src/components/ui/*.tsx \| wc -l` | 15 (14 required + input-group transitive) |
| `ls apps/dashboard/src/components/ui/skeleton*` | absent (banned — correct) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Environment] `drizzle-kit push` deferred to deploy path**
- **Found during:** Task 2 pre-flight.
- **Issue:** `DATABASE_URL` is unset in this local executor, and the RDS Proxy established in Phase 1 is VPC-private — not reachable from a local machine without a jumpbox. Running `drizzle-kit push` surfaces `Please provide required params for Postgres driver: url: ''`.
- **Decision:** Do NOT hack around this with a local Postgres substitute or fake credentials — the migrations are authored correctly and committed as SQL files (the source of truth). The push step happens in the Plan 04 deploy path, either via the dashboard-api Lambda's cold-start migration hook or via a dev jumpbox session.
- **Follow-up:** Plan 04 Task N must either (a) wire the dashboard-api Lambda to run `drizzle-kit migrate` on cold start behind a guard flag, or (b) document a `tools/scripts/migrate-dev.sh` that SSH-tunnels through a bastion to RDS Proxy for manual execution. This decision is owed to Plan 04.
- **Files modified:** none (SQL files shipped as intended).
- **Commit:** n/a (a deferred environment concern, not a code deviation).

**2. [Rule 1 — Consistency] owner_id literal differs from plan**
- **Found during:** Task 1 migration authoring.
- **Issue:** Plan text specified `owner_id UUID NOT NULL DEFAULT '7a6b5c4d-0000-0000-0000-000000000001'::uuid`. The existing migrations 0001-0006 + `packages/db/src/owner.ts` pin KEVIN_OWNER_ID to `'7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c'`.
- **Fix:** Used the existing canonical UUID in 0007 + 0008. Breaking consistency with six prior migrations and the code helper for a single plan's literal would have been strictly worse — the plan's literal was a typo against the established value.
- **Files modified:** `packages/db/drizzle/0007_entity_merge_audit.sql`, `packages/db/drizzle/0008_inbox_index.sql`.
- **Commit:** `42c7f4d`.

**3. [Rule 3 — Build tooling] `next lint` deprecated; migrated to direct `eslint .`**
- **Found during:** Task 3 lint verification.
- **Issue:** Next 15.5 prints "`next lint` is deprecated and will be removed in Next.js 16." and the built-in config references `no-unassigned-vars` which doesn't exist in ESLint 9.14 → `TypeError: Could not find "no-unassigned-vars" in plugin "@"`.
- **Fix:** Changed `apps/dashboard/package.json` script from `next lint` to `eslint .`. Directly uses the flat config via `eslint-config-next/core-web-vitals` through `FlatCompat`.
- **Files modified:** `apps/dashboard/package.json` (scripts.lint).
- **Commit:** `ed825f9`.

**4. [Rule 3 — Dependency compatibility] Dropped @eslint/js from the flat config**
- **Found during:** Task 3 first lint run.
- **Issue:** `@eslint/js@10.0.1` (auto-installed by `pnpm add`) references `no-unassigned-vars` in its recommended rules, but ESLint 9.14 doesn't know that rule name. Mismatch surfaces as `TypeError: Key "rules": Key "no-unassigned-vars": Could not find "no-unassigned-vars" in plugin "@"`.
- **Fix:** Removed `js.configs.recommended` from the flat config; typescript-eslint's recommended config already provides the JS baseline rules we need. Dropped the `@eslint/js` import. (Leaving the package in devDeps is harmless.)
- **Files modified:** `apps/dashboard/eslint.config.mjs`.
- **Commit:** `ed825f9`.

**5. [Rule 3 — Scope] Ignored src/components/ui/** from our ESLint rules**
- **Found during:** Task 3 lint wiring.
- **Issue:** shadcn primitives are upstream-authored templates that use `data-slot` attributes, oklch colors, and other patterns that aren't "ours to police."
- **Fix:** Added `src/components/ui/**` to the `ignores` block. Wave 1+ view code that CONSUMES these primitives is still linted.
- **Files modified:** `apps/dashboard/eslint.config.mjs`.
- **Commit:** `ed825f9`.

### Deferred Issues

**1. `drizzle-kit push` live apply + verify-notify smoke test**
- Requires `DATABASE_URL` pointed at the in-VPC RDS Proxy. Plan 04 deploy path owns this. No change here; SQL is the contract.

**2. Pre-existing zod peer-warning cascade** (carried forward from 03-00)
- @anthropic-ai/claude-agent-sdk + @langfuse/otel want zod@^3.25 || ^4; monorepo is on zod@3.23.8. Warnings only — install + typecheck + build all pass. Dedicated infra bump owed.

**3. Dashboard build "multiple lockfiles" warning**
- Next detects `C:\Users\Jzine\package-lock.json` above the repo as a second lockfile and infers the wrong workspace root. Cosmetic warning; does not affect builds. Can be silenced later via `outputFileTracingRoot` in next.config.ts.

### Auth gates

None — entirely filesystem + pnpm registry + existing local deps.

## Ready for Wave 1

Every Wave 1 plan (03-02..03-13) can now:
- Import `entityMergeAudit`, `inboxIndex` from `@kos/db/schema` with full Drizzle type safety.
- Assume migrations 0007-0010 describe the target schema shape (apply happens in deploy).
- Compose views from shadcn primitives in `@/components/ui/*` with `cn()` + `getBolagClass()` / `getBolagToken()` helpers.
- Rely on `.badge.bolag-{tf,ob,pe}` utility classes rendering a tint that derives from a single `--color-<token>`.
- Write JSX with confidence that `next build && eslint .` will catch raw hex, `dangerouslySetInnerHTML`, Drizzle in Vercel code, and Node packages in Edge middleware before the code merges.

## Known Stubs

These stubs are intentional — primitives landed; views land in downstream plans:

| File | Reason | Resolved In |
| --- | --- | --- |
| `apps/dashboard/src/components/ui/*` (14 primitives) | Raw shadcn components; no page composes them yet | Plans 03-04..03-09 (views) |
| `apps/dashboard/src/lib/bolag.ts` | Exported but not yet consumed by any view | Plans 03-04 (Today) onwards |
| `packages/db/drizzle/0007..0010` (authored, not applied) | SQL committed as source of truth; apply step owned by Plan 04 deploy | Plan 03-04 (deploy of dashboard-api Lambda with migration hook) |
| `packages/db/src/schema.ts` `entityMergeAudit`/`inboxIndex` | Type-safe objects ready; no queries written yet | Plan 03-03/05/07 (dashboard-api routes) |

## Self-Check

### Files created / exist

- FOUND: `packages/db/drizzle/0007_entity_merge_audit.sql`
- FOUND: `packages/db/drizzle/0008_inbox_index.sql`
- FOUND: `packages/db/drizzle/0009_listen_notify_triggers.sql`
- FOUND: `packages/db/drizzle/0010_entity_timeline_indexes.sql`
- FOUND: `packages/db/src/schema.ts` (entityMergeAudit + inboxIndex present)
- FOUND: `apps/dashboard/components.json`
- FOUND: `apps/dashboard/eslint.config.mjs`
- FOUND: `apps/dashboard/src/lib/utils.ts`
- FOUND: `apps/dashboard/src/lib/bolag.ts`
- FOUND: `apps/dashboard/src/components/ui/button.tsx`
- FOUND: `apps/dashboard/src/components/ui/card.tsx`
- FOUND: `apps/dashboard/src/components/ui/dialog.tsx`
- FOUND: `apps/dashboard/src/components/ui/command.tsx`
- FOUND: `apps/dashboard/src/components/ui/input.tsx`
- FOUND: `apps/dashboard/src/components/ui/textarea.tsx`
- FOUND: `apps/dashboard/src/components/ui/tabs.tsx`
- FOUND: `apps/dashboard/src/components/ui/separator.tsx`
- FOUND: `apps/dashboard/src/components/ui/scroll-area.tsx`
- FOUND: `apps/dashboard/src/components/ui/sonner.tsx`
- FOUND: `apps/dashboard/src/components/ui/avatar.tsx`
- FOUND: `apps/dashboard/src/components/ui/tooltip.tsx`
- FOUND: `apps/dashboard/src/components/ui/kbd.tsx`
- FOUND: `apps/dashboard/src/components/ui/dropdown-menu.tsx`
- FOUND: `apps/dashboard/src/components/ui/input-group.tsx` (transitive)
- FOUND: `apps/dashboard/tests/unit/bolag.test.ts`
- ABSENT (correct): `apps/dashboard/src/components/ui/skeleton*` (banned)

### Commits exist

- FOUND: `42c7f4d` (Task 1 — migrations 0007-0010 + Drizzle schema)
- FOUND: `ed825f9` (Task 3 — shadcn init + 14 components + bolag + ESLint)

## Self-Check: PASSED
