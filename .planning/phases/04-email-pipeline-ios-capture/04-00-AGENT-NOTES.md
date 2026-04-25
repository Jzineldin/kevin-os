# Phase 4 Plan 04-00 — Agent Execution Notes

Date: 2026-04-25
Branch: `phase-04-email-pipeline`

## Files created (33 total)

### Task 1 — 6 service workspaces (24 files)

| Service | package.json | tsconfig.json | vitest.config.ts | src/handler.ts |
|---|---|---|---|---|
| `services/ios-webhook` | 29 | 16 | 7 | 15 |
| `services/ses-inbound` | 28 | 15 | 7 | 16 |
| `services/emailengine-webhook` | 26 | 15 | 7 | 16 |
| `services/emailengine-admin` | 24 | 15 | 7 | 16 |
| `services/email-triage` | 41 | 18 | 7 | 27 |
| `services/email-sender` | 30 | 15 | 7 | 21 |

All 6 stub handlers `throw new Error('Phase 4 service <name>: handler body not yet implemented — see Plan 04-NN')` so a misconfigured deploy cannot accidentally accept traffic before the real plan ships (T-04-SCAFFOLD-05 mitigation).

### Task 2 — Zod schemas (3 files)

- `packages/contracts/src/email.ts` — 157 lines — 6 schemas:
  `CaptureReceivedIosSchema`, `CaptureReceivedEmailForwardSchema`, `CaptureReceivedEmailInboxSchema`, `DraftReadySchema`, `EmailApprovedSchema`, `InboxDeadLetterSchema`
- `packages/contracts/src/index.ts` — added `export * from './email.js';`
- `packages/contracts/package.json` — added `"./email": "./src/email.ts"` subpath export
- `packages/contracts/test/email.test.ts` — 231 lines — 13 tests

### Task 3 — Migration + Drizzle + validator (3 files)

- `packages/db/drizzle/0016_phase_4_email_and_dead_letter.sql` — 95 lines — 3 tables (`email_drafts`, `email_send_authorizations`, `agent_dead_letter`), 5 indexes, 1 unique constraint `(account_id, message_id)`, every table has `owner_id uuid NOT NULL`
- `packages/db/src/schema.ts` — appended Drizzle pgTable definitions for the 3 new tables (`emailDrafts`, `emailSendAuthorizations`, `agentDeadLetter`)
- `scripts/validate-migration-syntax.mjs` — 123 lines — token-grep validator (Phase-4-aware + generic balance check)

### Task 4 — withTimeoutAndRetry (2 files)

- `services/_shared/with-timeout-retry.ts` — 230 lines — exports `withTimeoutAndRetry`, `defaultShouldRetry`, `writeDeadLetter`, `PgPoolLike`, `WithTimeoutAndRetryOpts`
- `services/_shared/with-timeout-retry.test.ts` — 512 lines — **23 tests** (16 in the original numbered list + 5 `defaultShouldRetry` classifier tests + 2 standalone `writeDeadLetter` tests)

### Task 5 — Test fixtures (5 files)

- `packages/test-fixtures/src/adversarial-email.ts` — 79 lines — `ADVERSARIAL_INJECTION_EMAIL`
- `packages/test-fixtures/src/duplicate-email.ts` — 70 lines — `DUPLICATE_EMAIL_FIXTURES`, `DUPLICATE_EMAIL_DIFFERENT_MESSAGE_ID`
- `packages/test-fixtures/src/forwarded-email.ts` — 73 lines — `FORWARDED_EMAIL_MIME`, `FORWARDED_EMAIL_HEADERS_ONLY`
- `packages/test-fixtures/src/ios-shortcut.ts` — 122 lines — `IOS_SHORTCUT_PAYLOAD_FIXTURES`, `signIosShortcutBody`
- `packages/test-fixtures/src/index.ts` — added 4 re-exports

### Task 6 — pnpm-workspace.yaml

No changes required — existing `services/*` glob covers all 6 new dirs.

## Verification results

| Command | Result |
|---|---|
| `pnpm install` | OK — 27 new packages added; only pre-existing peer-dep warnings unchanged from base branch |
| `pnpm --filter @kos/contracts typecheck` | OK |
| `pnpm --filter @kos/contracts test` | 21/21 pass (8 pre-existing brief tests + 13 new email tests) |
| `pnpm --filter @kos/service-email-triage typecheck` | OK |
| `pnpm --filter @kos/service-{ios-webhook,ses-inbound,emailengine-webhook,emailengine-admin,email-sender} typecheck` | OK (all 5) |
| `pnpm --filter @kos/db typecheck` | OK |
| `pnpm --filter @kos/test-fixtures typecheck` | OK |
| `node scripts/validate-migration-syntax.mjs packages/db/drizzle/0016_phase_4_email_and_dead_letter.sql` | exit 0 |
| `cd services/_shared && npx --package=vitest@2.1.4 vitest run with-timeout-retry` | 23/23 pass |
| Fixture barrel resolves all 5 named exports | OK (`ADVERSARIAL_INJECTION_EMAIL`, `DUPLICATE_EMAIL_FIXTURES`, `FORWARDED_EMAIL_MIME`, `IOS_SHORTCUT_PAYLOAD_FIXTURES`, `signIosShortcutBody`) |

## Deviations from plan

1. **Migration number bumped to 0016 (not 0012 / 0013).** Per execution instructions: 0012 (Phase 6), 0014 + 0015 (Phase 7) had already landed, so the next free integer was 0016. All references in the migration body, the Drizzle schema header comment, and the validation script point to 0016. Plans 04-04 / 04-05 will reference 0016 verbatim when they land.

2. **`services/<new>/tsconfig.json` does NOT include `../_shared/**/*.ts`.** The triage tsconfig pattern includes the `_shared` glob, which forces tsc to typecheck every `_shared/*.ts` file (e.g. `tracing.ts` which depends on `@opentelemetry/sdk-trace-node` + `@arizeai/openinference-instrumentation-claude-agent-sdk` + `@langfuse/otel`). Stub handlers don't import from `_shared` yet, and dragging the OTel dep footprint into all 6 stubs to satisfy a glob that compiles unused source was the wrong tradeoff. Plans 04-01..04-05 will add `../_shared/**/*.ts` (or specific files) to the include list AND the matching deps when the real handler bodies need `initSentry` / `setupOtelTracingAsync`.

   `services/email-triage` does retain the OTel + Sentry + arizeai devDeps in `package.json` because Plan 04-04's body will use them; the include glob can be re-added there at the same time.

3. **Test 7 (exponential backoff) restructured to avoid fake timers.** Verifying the formula by spying on the backoff callback's `attempt` argument is more deterministic than driving fake timers through the retry loop, which leaked an unhandled rejection in vitest 2.1.4. The default formula `2^attempt * 1000` is asserted directly. The spirit of "verify exponential backoff via fake timers" is preserved (we observe 1000ms, 2000ms in the schedule).

4. **Test 16 changed from `timeoutMs: 0` to `timeoutMs: 1`.** With `timeoutMs: 0`, `setTimeout(fn, 0)` schedules in the next macrotask while `Promise.resolve()` resolves in the microtask queue first, so a yielded `fn` wins the race. `timeoutMs: 1` against a `setTimeout(r, 25)`-yielding `fn` exhibits the intended "very-short-timeout-fires-dead-letter" behaviour.

5. **Test count = 23 (target was 15+).** Added 5 `defaultShouldRetry` classifier tests + 2 `writeDeadLetter` standalone tests on top of the 16 numbered cases in the plan, since the classifier and the dead-letter writer are publicly exported and worth their own coverage.

6. **Fixture files use `as const` discriminator literals** so consumers get strict literal types (e.g. `channel: 'email-inbox' as const`). They are NOT validated against the Zod schemas at fixture-definition time — the schemas exist alongside them and any drift would surface immediately in Plan 04-01..04-05 tests that parse the fixtures.

7. **`packages/test-fixtures/dist/` outputs to `dist/src/`.** The tsconfig has `rootDir: '.'` (matches test-fixtures convention; not changed) so the build emits `dist/src/index.js` rather than `dist/index.js`. The plan's verify command was updated mentally to `dist/src/index.js`; functionally identical. Source-import path (`@kos/test-fixtures` → `./src/index.ts`) is unaffected.

## What is NOT in this scaffold (and why)

- **CDK stacks** for the 6 new Lambdas. Plan 04-NN owns its own stack additions per existing convention (e.g. notion-indexer, dossier-loader). Wave 0 stays code-only.
- **Real handler bodies.** Stubs only. Each handler throws an informative error on invocation.
- **`@kos/context-loader` import in email-triage handler stub.** Listed in dependencies (with `peerDependenciesMeta.optional` for forward-compat), but the stub does not call it. Plan 04-04 wires the actual `loadContext` call.
- **DataStack updates** to seed `kos/dashboard-bearer`, `kos/ee-webhook-secret`, `kos/ios-shortcut-hmac-key`. Out of scope for Wave 0; landed in Plans 04-01..04-03.
- **Migration auto-execution.** `db-push.sh` is NOT run from this plan. Operator runs it during Plan 04-04 deploy.
