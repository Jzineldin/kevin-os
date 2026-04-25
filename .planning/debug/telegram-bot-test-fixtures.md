---
slug: telegram-bot-test-fixtures
status: resolved
trigger: |
  Bug A: pnpm typecheck fails on services/telegram-bot with "Cannot find module '@kos/test-fixtures'" in test/handler.test.ts (TS2307). Likely missing workspace dep declaration in services/telegram-bot/package.json. Check how other services that import @kos/test-fixtures declare it and replicate the pattern.
created: 2026-04-23
updated: 2026-04-23
---

# Debug Session: telegram-bot-test-fixtures

## Symptoms

- **Expected behavior:** `pnpm typecheck` should succeed across the monorepo; services/telegram-bot test files should resolve `@kos/test-fixtures` as a workspace dependency.
- **Actual behavior:** TypeScript cannot find module `@kos/test-fixtures` in services/telegram-bot/test/handler.test.ts.
- **Error messages:** `test/handler.test.ts(2,40): error TS2307: Cannot find module '@kos/test-fixtures'`
- **Timeline:** Surfaced during EC2 bootstrap on 2026-04-23 after pnpm install. Also present on Windows before migration — not an environment issue.
- **Reproduction:** `cd ~/projects/kevin-os && pnpm typecheck` (fails on services/telegram-bot package).
- **Hypothesis from user:** services/telegram-bot/package.json is missing `"@kos/test-fixtures": "workspace:*"` in devDependencies. Other services that consume it declare it properly — replicate that pattern.

## Current Focus

- hypothesis: packages/test-fixtures/package.json points `main`/`types`/`exports` at a `./dist/...` build output that does not exist; sibling packages (contracts, db, resolver) point at source directly.
- test: verify telegram-bot already declares the dep; verify symlink exists in node_modules; verify dist/ is absent; compare against sibling packages.
- expecting: dep declaration is already present and correct; root cause is the build-artifact pointer in test-fixtures/package.json.
- next_action: align test-fixtures/package.json with the source-pointer pattern used by @kos/contracts, then re-run typecheck.

## Evidence

- 2026-04-23: services/telegram-bot/package.json line 28 already declares `"@kos/test-fixtures": "workspace:*"` in devDependencies — user's hypothesis (missing dep) is wrong.
- 2026-04-23: services/telegram-bot/node_modules/@kos/test-fixtures is a valid symlink to packages/test-fixtures — pnpm linking is correct.
- 2026-04-23: packages/test-fixtures/package.json has `"main": "./dist/src/index.js"`, `"types": "./dist/src/index.d.ts"`, and exports `./dist/src/index.d.ts`.
- 2026-04-23: packages/test-fixtures/dist/ does not exist — package has never been built.
- 2026-04-23: sibling packages @kos/contracts, @kos/db, @kos/resolver all use `"main": "./src/index.ts"` and `"types": "./src/index.ts"` (source pointers, no build step required). This is the monorepo convention for unbuilt workspace packages.
- 2026-04-23: only services/telegram-bot/test/handler.test.ts actually imports from `@kos/test-fixtures` in a file included by `tsc --noEmit`. That's why only telegram-bot's typecheck broke even though other services declare the dep.
- 2026-04-23: reproduced failure with `pnpm --filter @kos/service-telegram-bot typecheck` → TS2307 as reported.

## Eliminated

- Missing workspace dep in telegram-bot/package.json (user's original hypothesis) — already declared correctly.
- Broken pnpm symlink — symlink present and resolves to packages/test-fixtures.
- tsconfig paths misconfiguration — other workspace packages (`@kos/contracts`) resolve fine with the same tsconfig base.
- Environment issue (Windows vs EC2) — reproduces on both.

## Resolution

- **root_cause:** `packages/test-fixtures/package.json` declared `main`/`types`/`exports` pointing at `./dist/...` build artifacts that are never produced (no build step before typecheck), so TypeScript resolved the symlinked package but could not find its declaration files. Sibling `@kos` packages in this monorepo point `main`/`types` at source (`./src/index.ts`); `test-fixtures` was the only outlier.
- **fix:** Updated `packages/test-fixtures/package.json` to match the source-pointer convention: `main`/`types` → `./src/index.ts`, `exports` → `{ ".": "./src/index.ts", "./dashboard": "./src/dashboard/index.ts" }`. No code changes required in telegram-bot or other consumers.
- **verification:**
  - `pnpm --filter @kos/service-telegram-bot typecheck` → passes
  - `pnpm typecheck` (full monorepo) → all 23 packages pass
  - `pnpm --filter @kos/service-telegram-bot test` → 5/5 tests pass (fixture imports work at runtime)
- **specialist_hint:** typescript
