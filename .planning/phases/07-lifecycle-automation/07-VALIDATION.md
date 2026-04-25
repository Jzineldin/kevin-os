# Phase 7: Validation Matrix (Nyquist)

**Purpose:** Each task in each plan has an automated verification command that proves the task's `<done>` criteria.

```yaml
nyquist_compliant: true
```

---

## Plan 07-00 — Wave 0 scaffold

| Task | Files | Automated verify |
|------|-------|------------------|
| 1. Scaffold 4 service packages + @kos/contracts brief.ts | services/{morning-brief,day-close,weekly-review,verify-notification-cap}/package.json; services/_shared/brief-renderer.ts; packages/contracts/src/brief.ts | `pnpm --filter @kos/contracts test -- --run brief --reporter=basic` |
| 2. Zod schemas (MorningBriefSchema + DayCloseBriefSchema + WeeklyReviewSchema) | packages/contracts/src/brief.ts + packages/contracts/test/brief.test.ts | `pnpm --filter @kos/contracts test -- --run brief --reporter=basic` |
| 3. Migration 0014 (or next-available) — top3_membership + dropped_threads_v + acted_on_at trigger | packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql | `grep -q "CREATE TABLE.*top3_membership" packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql && grep -q "CREATE OR REPLACE VIEW dropped_threads_v" packages/db/drizzle/0014_phase_7_top3_and_dropped_threads.sql && echo OK` |
| 4. CDK stub `integrations-lifecycle.ts` (helper signature + empty body) | packages/cdk/lib/stacks/integrations-lifecycle.ts + packages/cdk/test/integrations-lifecycle.test.ts | `pnpm --filter @kos/cdk test -- --run integrations-lifecycle --reporter=basic` |

---

## Plan 07-01 — Wave 1 morning-brief Lambda (AUTO-01)

| Task | Files | Automated verify |
|------|-------|------------------|
| 1. brief-renderer.ts shared helper (Notion blocks + Telegram HTML) | services/_shared/brief-renderer.ts + services/_shared/test/brief-renderer.test.ts | `pnpm --filter @kos/shared test -- --run brief-renderer --reporter=basic` |
| 2. morning-brief Lambda (handler + agent + persist) | services/morning-brief/src/{handler,agent,persist,notion}.ts + test/{handler,agent,persist}.test.ts | `pnpm --filter @kos/service-morning-brief test -- --run --reporter=basic` |
| 3. CDK schedule wiring for morning-brief (08:00 weekdays Stockholm) | packages/cdk/lib/stacks/integrations-lifecycle.ts + packages/cdk/test/integrations-lifecycle.test.ts | `pnpm --filter @kos/cdk test -- --run integrations-lifecycle --reporter=basic` |

---

## Plan 07-02 — Wave 1 parallel: day-close + weekly-review

| Task | Files | Automated verify |
|------|-------|------------------|
| 1. day-close Lambda | services/day-close/src/{handler,agent,persist,notion}.ts + test/*.test.ts | `pnpm --filter @kos/service-day-close test -- --run --reporter=basic` |
| 2. weekly-review Lambda | services/weekly-review/src/{handler,agent,persist,notion}.ts + test/*.test.ts | `pnpm --filter @kos/service-weekly-review test -- --run --reporter=basic` |
| 3. CDK schedules for day-close + weekly-review + IAM grants | packages/cdk/lib/stacks/integrations-lifecycle.ts + packages/cdk/test/integrations-lifecycle.test.ts | `pnpm --filter @kos/cdk test -- --run integrations-lifecycle --reporter=basic` |

---

## Plan 07-03 — Wave 2: AUTO-02 scheduler (schedule only)

| Task | Files | Automated verify |
|------|-------|------------------|
| 1. CDK scheduler entry for email-triage every 2h → kos.system/scan_emails_now | packages/cdk/lib/stacks/integrations-lifecycle.ts + packages/cdk/test/integrations-lifecycle.test.ts | `pnpm --filter @kos/cdk test -- --run integrations-lifecycle --reporter=basic 2>&1 \| grep -E "email-triage-every-2h\|scan_emails_now"` |

---

## Plan 07-04 — Wave 3: compliance verifiers + E2E gate

| Task | Files | Automated verify |
|------|-------|------------------|
| 1. verify-notification-cap Lambda (reads agent_runs + DynamoDB cap) | services/verify-notification-cap/src/handler.ts + test/handler.test.ts | `pnpm --filter @kos/service-verify-notification-cap test -- --run --reporter=basic` |
| 2. scripts/verify-notification-cap-14day.mjs + verify-quiet-hours-invariant.mjs + verify-phase-7-e2e.mjs | scripts/verify-notification-cap-14day.mjs + scripts/verify-quiet-hours-invariant.mjs + scripts/verify-phase-7-e2e.mjs | `node --check scripts/verify-notification-cap-14day.mjs && node --check scripts/verify-quiet-hours-invariant.mjs && node --check scripts/verify-phase-7-e2e.mjs && echo script-OK` |
| 3. CDK weekly cap-verify schedule + SNS publish IAM grant | packages/cdk/lib/stacks/integrations-lifecycle.ts + packages/cdk/test/integrations-lifecycle.test.ts | `pnpm --filter @kos/cdk test -- --run integrations-lifecycle --reporter=basic` |

---

## Coverage summary

- **Total tasks:** 13 (4 + 3 + 3 + 1 + 3)
- **Automated (vitest or CLI):** 13 / 13
- **Manual operator-verify:** 0 — everything at plan time is file-creation + test-assertion. First live Kevin-visible execution is an operator runbook item (post-deploy Notion page seeding + a forced early-morning brief fire via AWS CLI).
- **Post-deploy operator verifications (NOT Phase 7 plan tasks):**
  - One-time: seed `todayPage` + `dailyBriefLog` IDs in `scripts/.notion-db-ids.json`.
  - One-time: confirm Daily Brief Log DB has `Type` (select) + `Date` (date) + `Name` (title) columns.
  - First-deploy: trigger a manual brief via `aws lambda invoke` to validate live output; inspect 🏠 Today rendering.

```yaml
nyquist_compliant: true
```
