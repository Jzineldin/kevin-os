# Phase 5 Plan 05-00 — Agent Execution Notes

Wave 0 scaffold for Phase 5 (messaging channels: Chrome MV3 + LinkedIn DMs +
Baileys WhatsApp + Discord). All four tasks executed end-to-end. No
behaviour, no CDK — pure boilerplate so Plans 05-01..05-07 can layer on.

## File list (created / modified)

### New workspaces (6)

```
apps/chrome-extension/package.json                 23
apps/chrome-extension/tsconfig.json                14
apps/chrome-extension/vitest.config.ts              7
apps/chrome-extension/esbuild.config.mjs           46
apps/chrome-extension/src/manifest.json            43
apps/chrome-extension/src/background.ts            17  (throws SCAFFOLD)
apps/chrome-extension/src/content-highlight.ts     12
apps/chrome-extension/src/content-linkedin.ts      13
apps/chrome-extension/src/options.html             27
apps/chrome-extension/src/options.ts                9
apps/chrome-extension/test/setup.ts                10  (imports installMV3Stub)

services/chrome-webhook/package.json               28
services/chrome-webhook/tsconfig.json              15
services/chrome-webhook/vitest.config.ts            7
services/chrome-webhook/src/handler.ts             18  (throws SCAFFOLD)
services/chrome-webhook/test/handler.test.ts       13  (describe.skip)

services/linkedin-webhook/package.json             28
services/linkedin-webhook/tsconfig.json            15
services/linkedin-webhook/vitest.config.ts          7
services/linkedin-webhook/src/handler.ts           18  (throws SCAFFOLD)
services/linkedin-webhook/test/handler.test.ts     11  (describe.skip)

services/baileys-sidecar/package.json              29
services/baileys-sidecar/tsconfig.json             15
services/baileys-sidecar/vitest.config.ts           7
services/baileys-sidecar/src/handler.ts            20  (throws SCAFFOLD)
services/baileys-sidecar/test/handler.test.ts      11  (describe.skip)

services/baileys-fargate/package.json              26
services/baileys-fargate/tsconfig.json             15
services/baileys-fargate/vitest.config.ts           7
services/baileys-fargate/Dockerfile                18
services/baileys-fargate/src/entrypoint.ts         32  (export main → throws; not run on import)
services/baileys-fargate/test/entrypoint.test.ts   11  (describe.skip)

services/verify-gate-5-baileys/package.json        27
services/verify-gate-5-baileys/tsconfig.json       15
services/verify-gate-5-baileys/vitest.config.ts     7
services/verify-gate-5-baileys/src/handler.ts      21  (throws SCAFFOLD)
services/verify-gate-5-baileys/test/handler.test.ts 11 (describe.skip)
```

### Contracts (Task 2)

```
packages/contracts/src/events.ts                  396  (added 5 capture schemas
                                                       + extended discriminatedUnion
                                                       + 5 type exports + SystemAlertSchema)
packages/contracts/test/phase-5-captures.test.ts  257  (15 tests, all green)
```

New exports from `@kos/contracts`:

- `CaptureReceivedChromeHighlightSchema` + type
- `CaptureReceivedLinkedInDmSchema` + type
- `CaptureReceivedWhatsappTextSchema` + type
- `CaptureReceivedWhatsappVoiceSchema` + type
- `CaptureReceivedDiscordTextSchema` + type
- `SystemAlertSchema` + `SystemAlert` type
- `CaptureReceivedSchema` discriminated union now includes the five new
  capture kinds (existing `text`/`voice` arms unchanged)

### Migration (Task 3) — number bumped 0017 → 0019

The plan reserved migration `0017_phase_5_messaging.sql`, but at execution
time the `packages/db/drizzle/` directory already contained:

```
0001..0011    (Phase 1 + 2 + 3)
0012          (Phase 6 — dossier cache)
0014, 0015    (Phase 7 — top3 + writer role)
0016, 0017, 0018  (Phase 4 retroactively — email + sender + triage roles)
```

So the next free sequential number is **0019**. The migration file lives at
`packages/db/drizzle/0019_phase_5_messaging.sql` (87 lines, 3 tables,
4 indexes, BEGIN/COMMIT wrapped, with operator-only ROLLBACK comments).

Tables created:

| Table                  | PK                          | Owner column       | Notes |
|------------------------|-----------------------------|--------------------|-------|
| whatsapp_session_keys  | (owner_id, key_id)          | owner_id NOT NULL  | Baileys pluggable auth state |
| system_alerts          | id (uuid)                   | owner_id NOT NULL  | Partial idx on `ack_at IS NULL` |
| sync_status            | (owner_id, channel)         | owner_id NOT NULL  | last_healthy_at + queue_depth + paused_until |

### Test fixtures (Task 4)

```
packages/test-fixtures/src/phase-5/mv3-runtime-stub.ts    79
packages/test-fixtures/src/phase-5/voyager-response.ts    55
packages/test-fixtures/src/phase-5/baileys-incoming.ts    57
packages/test-fixtures/src/phase-5/index.ts                9  (barrel)
packages/test-fixtures/src/index.ts                       28  (added phase-5 re-export)
```

New exports from `@kos/test-fixtures`:

- `installMV3Stub`, `uninstallMV3Stub`
- `voyagerConversationsResponse`, `voyagerThreadEventsResponse`
- `baileysIncomingTextEnvelope`, `baileysIncomingVoiceEnvelope`

Smoke test confirmed via `node --input-type=module -e "import {installMV3Stub,
voyagerConversationsResponse, baileysIncomingTextEnvelope} from
'.../dist/src/phase-5/index.js'; ..."` → `OK: function object object`.

## Verification outputs

### `pnpm install`
```
Done in 21.2s
WARN unmet peer zod (pre-existing — not introduced by this plan)
```

### `pnpm -r typecheck` — every workspace `Done`
All 50 workspaces typechecked clean (full output is workspaces × `tsc --noEmit`
all returning success). The 6 new workspaces specifically:

```
services/chrome-webhook typecheck: Done
services/linkedin-webhook typecheck: Done
services/baileys-sidecar typecheck: Done
services/baileys-fargate typecheck: Done
services/verify-gate-5-baileys typecheck: Done
apps/chrome-extension typecheck: Done
```

### `pnpm --filter @kos/contracts test`
```
✓ test/brief.test.ts            (8 tests)
✓ test/email.test.ts            (13 tests)
✓ test/phase-5-captures.test.ts (15 tests)  <-- NEW
Test Files  3 passed (3)
Tests  36 passed (36)
```

### Stub workspace tests (all `describe.skip`, `passWithNoTests` flag honored)
```
services/chrome-webhook         1 skipped  (placeholder)
services/linkedin-webhook       1 skipped  (placeholder)
services/baileys-sidecar        1 skipped  (placeholder)
services/baileys-fargate        1 skipped  (placeholder)
services/verify-gate-5-baileys  1 skipped  (placeholder)
apps/chrome-extension           No test files found, exiting with code 0
```

### `pnpm -r test`
Background run completed `exit code 0`. No new failures introduced; existing
Phase 4 / Phase 6 / Phase 7 tests continue to pass.

### `pnpm --filter @kos/test-fixtures build`
Built cleanly. Output verified at `packages/test-fixtures/dist/src/phase-5/`
(index.js, mv3-runtime-stub.js, voyager-response.js, baileys-incoming.js
+ matching .d.ts files).

## Deviations from the plan

1. **Migration number bumped 0017 → 0019.** The plan's next-number guard
   anticipated this exact scenario and instructed bumping to the next free
   number. References inside the SQL preamble document the reasoning.

2. **`baileys-fargate/src/entrypoint.ts` exports `main()` instead of
   throwing at module top level.** Top-level `throw` would break vitest
   resolution + tsc workspace traversal. The file exposes `export async
   function main(): Promise<never>` that throws SCAFFOLD; an
   `isMain`-guarded auto-invoke at the bottom only fires when the file is
   the process entrypoint (i.e., `node dist/entrypoint.js` inside the
   Docker `CMD`). Net effect identical to the plan's intent: a stray
   `docker run` on the scaffold image fails immediately, but the workspace
   can be typechecked / imported by downstream tests without a synthetic
   crash.

3. **No `tsconfig.json` `references` updates required.** The repo does not
   use TypeScript project references between workspaces — each workspace's
   `tsconfig.json` extends `../../tsconfig.base.json` and resolves cross-
   workspace types via the existing `@kos/*` `paths` mapping pattern. The
   plan's wording ("Add all 6 new workspaces to root tsconfig.json project
   references") is a no-op against the current repo shape and was skipped.

4. **`pnpm-workspace.yaml` already wildcards `apps/*`, `services/*`,
   `packages/*`.** No edits needed; pnpm picked up the new workspaces on
   the first install.

5. **No `apps/chrome-extension/test/setup.ts`-driven vitest globalSetup
   wiring yet.** The file exists per the plan's file list and the
   `installMV3Stub` import resolves; full `setupFiles: ['./test/setup.ts']`
   wiring lands in Plan 05-01 once there's a test that needs it. The
   scaffold's `vitest.config.ts` matches the canonical pattern across the
   repo (no setup files registered).

## Downstream plans unblocked

With Wave 0 in place, these Phase 5 plans can now execute in parallel:

- **Plan 05-01** (Chrome extension shell + options + background)
- **Plan 05-02** (Chrome highlight content script + chrome-webhook handler)
- **Plan 05-03** (LinkedIn content script + linkedin-webhook handler)
- **Plan 05-04** (Baileys Fargate container — `autonomous: false`, manual)
- **Plan 05-05** (baileys-sidecar Lambda handler)
- **Plan 05-06** (Discord fallback poller — service workspace not in
  Wave-0 file list; will scaffold its own workspace)
- **Plan 05-07** (verify-gate-5-baileys handler body)

## What was NOT done (per plan instructions)

- No `git add`, `git commit`, `git push`.
- No CDK / Terraform / cloud touches.
- No EmailEngine, AWS, Notion side effects.
- No Discord poller workspace (the plan's `files_modified` list does not
  include it; CAP-10 is covered at the contracts/schemas layer only —
  Plan 05-06 will scaffold its own workspace if needed).

End of agent notes.
