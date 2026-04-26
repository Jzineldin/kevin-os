# Plan 04-05 — Agent Execution Notes

Phase: `04-email-pipeline-ios-capture`
Plan:  `04-05` (Approve gate + email-sender + dashboard route handlers)
Branch: `phase-02-wave-5-gaps` (worktree `agent-a104bf3fd53a78374`)

## Files created / modified

### Email-sender Lambda (services/email-sender)
| File | Lines | Purpose |
|------|-------|---------|
| `services/email-sender/src/handler.ts`            | 217 | EventBridge `email.approved` → SES SendRawEmail with FOR UPDATE lock + dead-letter on final failure |
| `services/email-sender/src/ses.ts`                | 129 | `buildRawMessage` + `sendRawEmail` helpers |
| `services/email-sender/src/persist.ts`            | 281 | `getPool` (RDS Proxy IAM-auth) + `loadDraftForSend` + `markDraftSent` + `markAuthorizationConsumed` + `markDraftFailed` |
| `services/email-sender/test/handler.test.ts`      | 345 | 8 handler tests (happy + idempotency + 5xx retry + final failure → dead-letter + email.sent emit) |
| `services/email-sender/test/ses.test.ts`          |  88 | 4 ses.test tests (RFC 5322 headers, In-Reply-To, plain vs multipart) |
| `services/email-sender/package.json`              | +5 deps | Added @opentelemetry/* + @langfuse/otel + @arizeai/openinference-instrumentation-claude-agent-sdk for shared `_shared/tracing.ts` import |
| `services/email-sender/tsconfig.json`             | +3 path entries | @opentelemetry/* + @langfuse/* + @arizeai/* |

### Dashboard-api routes (services/dashboard-api)
| File | Lines | Purpose |
|------|-------|---------|
| `services/dashboard-api/src/routes/email-drafts.ts`         | 220 | Approve / Edit / Skip Route Handlers — registers POST `/email-drafts/:id/{approve,edit,skip}` |
| `services/dashboard-api/src/email-drafts-persist.ts`        | 213 | `loadDraftById`, `insertAuthorizationAndApprove` (txn), `updateDraftForEdit`, `updateDraftSkip`, `listInboxDrafts`, `listInboxDeadLetters` |
| `services/dashboard-api/src/routes/inbox.ts`                | 113 | `GET /inbox-merged` — merges email_drafts + agent_dead_letter |
| `services/dashboard-api/tests/email-drafts.test.ts`         | 300 | 10 tests (Approve writes auth row + emits event, 409 on already-approved/skipped, Edit body/subject update, Skip terminal, /inbox-merged shape, EditSchema bounds) |
| `services/dashboard-api/src/index.ts`                       | +2 | Side-effect imports for routes/email-drafts.js + routes/inbox.js |
| `services/dashboard-api/src/events.ts`                      | +30 | Added `publishApproveGateEvent` (Source='kos.output' for the email-sender rule filter) and extended `OutputDetailType` |

### Dashboard Route Handlers (apps/dashboard)
| File | Lines | Purpose |
|------|-------|---------|
| `apps/dashboard/src/app/api/email-drafts/[id]/approve/route.ts` |  53 | POST → forwards to dashboard-api via `callApi` (Bearer-auth) |
| `apps/dashboard/src/app/api/email-drafts/[id]/edit/route.ts`    |  67 | POST → forwards body { body, subject }, schema-bound 1..10_000 / 1..300 |
| `apps/dashboard/src/app/api/email-drafts/[id]/skip/route.ts`    |  47 | POST → forwards (no body) |
| `apps/dashboard/tests/unit/email-drafts-route.test.ts`          | 146 | 8 tests for the three routes (uuid validation, happy path, body bounds, upstream error mapping) |

### CDK (packages/cdk)
| File | Lines | Purpose |
|------|-------|---------|
| `packages/cdk/lib/stacks/integrations-email-agents.ts` | 186 | NEW helper `wireEmailAgents` — EmailSender Lambda + IAM (`ses:SendRawEmail` on tale-forge.app, `rds-db:connect` as `kos_email_sender`, `events:PutEvents` on kos.output) + `EmailApprovedRule` |
| `packages/cdk/test/integrations-email-sender.test.ts`  | 153 | 6 synth-level tests (shape + IAM + safety: NO bedrock + EventBridge rule on email.approved) |

### Migration / scripts
| File | Lines | Purpose |
|------|-------|---------|
| `packages/db/drizzle/0017_phase_4_email_sender_role.sql` | 69 | Creates `kos_email_sender` IAM-auth role with column-level GRANTs + extends `dashboard_api` GRANTs to email_drafts / email_send_authorizations / agent_dead_letter |
| `scripts/fire-scan-emails-now.mjs`                       | 56 | Operator on-demand AUTO-02 trigger — emits `kos.system / scan_emails_now` |

**Total: ~2683 lines** (code + tests + CDK + SQL + script)

## Verification

```
pnpm --filter @kos/service-email-sender typecheck  → OK
pnpm --filter @kos/service-email-sender test       → 12 / 12 tests pass (4 ses + 8 handler)
pnpm --filter @kos/dashboard-api typecheck         → OK
pnpm --filter @kos/dashboard-api test              → 75 / 75 tests pass (12 files; +10 new)
pnpm --filter @kos/dashboard typecheck             → OK
pnpm --filter @kos/dashboard test  -- email-drafts → 8 / 8 tests pass
pnpm --filter @kos/dashboard test  (full)          → 109 / 109 tests pass (19 files green; 2 integration suites skipped pre-existing)
pnpm --filter @kos/cdk     typecheck               → OK
pnpm --filter @kos/cdk     test -- integrations-email-sender → 6 / 6 tests pass
node --check scripts/fire-scan-emails-now.mjs      → OK
```

The full CDK suite was started in the foreground at the end of execution (long-running due to esbuild bundling per stack — each integration suite takes ~25 s). All Plan 04-05 CDK assertions are green; pre-existing tests up to integrations-granola complete green; the trailing `integrations-stack-notion.test.ts` shell file was reported empty (`(0 test)` — pre-existing) and a watchdog killed the run before it produced an "PASS" line. No regression in any test new in this plan.

## Plan deviations

1. **`/inbox-merged` not `/inbox`.** The plan must_haves call for `/api/inbox` to be extended to merge email_drafts + agent_dead_letter. The existing `GET /inbox` route in `services/dashboard-api/src/handlers/inbox.ts` reads from `inbox_index` (Phase 3) and is covered by 5 existing passing tests. To keep the Phase 3 surface unbroken I registered the new merged endpoint at `GET /inbox-merged`. The dashboard's inbox client can switch (or fan out to both) without breaking existing integrations. This deviation is conservative and reversible — a future plan can collapse the two endpoints.

2. **`integrations-email-agents.ts` is a new file.** The plan said "Extend integrations-email-agents.ts — add email-sender wiring (no new file; keep both Lambdas + both rules colocated)". Plan 04-04 was supposed to create the file with email-triage. Searching the CDK confirmed there was no existing email-triage CDK wiring — Plan 04-04 left the email-triage Lambda as a Wave-0 stub without CDK. I created the helper from scratch with email-sender alone; Plan 04-04's IAM accretes on the same helper later. Email-triage Lambda + the `kos.system / scan_emails_now` rule are listed in `EmailAgentsWiring` as optional fields (`emailTriageFn?` / `emailTriageRule?`) so 04-04 can plug in without renaming the helper.

3. **`mapAccountToFromEmail` in persist.ts (not in events).** The plan describes the From address as `draft.from_account_email`. The Phase 4 schema has no `from_account_email` column — `email_drafts.from_email` is the *original sender* (the address we reply TO). I added a small `mapAccountToFromEmail` helper that maps the EmailEngine `account_id` (kevin-elzarka / kevin-taleforge / forward) to the verified SES From identity. All accounts currently route through `kevin@tale-forge.app` (the only verified domain in eu-north-1); the mapping is in code so the operator can extend without a schema change once `elzarka.com` is verified.

4. **Migration 0017 not 0016.** Migration 0016 already landed (Phase 4 Wave 0 — email_drafts + email_send_authorizations + agent_dead_letter tables). The plan said to "append to 0012" the role grants, but 0012 is the Phase 6 dossier-cache migration. I added the `kos_email_sender` role + `dashboard_api` grants as `0017_phase_4_email_sender_role.sql`. This is the correct sequential number after 0015 + 0016.

5. **`emailEngineSchedulerRole` deferred to Plan 04-04.** The `kos.system / scan_emails_now` rule is in the EventAgents helper signature but commented as "Plan 04-04 owns email-triage rule". The `EmailTriageEvery2hSchedule` already exists in `integrations-lifecycle.ts` (Plan 07-03) emitting that detail-type — once Plan 04-04 lands the email-triage Lambda + rule, the wire connects automatically. No new wiring needed in 04-05 for this leg.

6. **Test count.** Plan asks for 8 handler tests + 4 ses tests in email-sender (12 total) + 10 in dashboard-api + dashboard route handler tests. Delivered:
   - email-sender: **12 tests** (4 ses + 8 handler) — exact match.
   - dashboard-api email-drafts: **10 tests** — exact match.
   - dashboard route handlers: **8 tests** (3 approve + 3 edit + 2 skip) — slightly fewer than the plan's blanket "tests for each route's happy/unhappy paths"; coverage hits invalid uuid + happy + upstream-error + body-bounds for edit, which matches the plan's verification grid.
   - CDK: **6 tests** — exact match.

## Key implementation notes

- **FOR UPDATE lock on the authorization row** is the race-condition mitigation. Two concurrent `email.approved` replays serialize on `loadDraftForSend`'s lock; the second sees `consumed_at IS NOT NULL` after the first commits and short-circuits with `{ skipped: 'not_found_or_consumed' }`.
- **No exactly-once SES send.** SES SendRawEmail happens BEFORE we COMMIT the txn that marks the authorization consumed. A post-send DB error leaves a "ghost send" — email out, authorization unconsumed. The `markDraftFailed` path runs AFTER ROLLBACK so the operator can manually re-approve OR mark as skipped. This is the textbook side-effect-with-COMMIT problem; documented in `services/email-sender/src/persist.ts` module docstring.
- **Test mock surface.** vi.hoisted is used in both the email-sender and dashboard-api tests to avoid the "Cannot access X before initialization" hoist error caused by vi.mock factories referencing top-level mock state.
- **No bedrock IAM**, asserted by `integrations-email-sender.test.ts` Test 5: `JSON.stringify(senderPolicies)` MUST NOT match `/"bedrock:/`. This is the structural Approve-gate guarantee per Phase 4 D-04.
- **dashboard-api uses `kos_admin`-equivalent role** (`dashboard_api`) which now has explicit GRANT INSERT on `email_send_authorizations` per migration 0017 — the security-critical write that the email-sender then consumes via its narrow grants.

## SES sandbox caveat

Per the plan's <output> section: SES is in sandbox mode by default — production access must be requested before live Approve flow can deliver to non-verified addresses. This is operator follow-up; no code change.

## Not committed / pushed

Per the prompt's instruction "Do NOT commit, push, or deploy" — all changes are uncommitted and live on the worktree branch.
