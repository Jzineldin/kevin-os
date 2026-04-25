---
phase: 04-email-pipeline-ios-capture
validation_plan: v1
nyquist_compliant: true
wave_0_complete: false
last_updated: 2026-04-24
---

# Phase 4: Email Pipeline + iOS Capture — Validation Plan

Per-task automated verification matrix. Every task has at least one runnable command; manual-only verifications are explicitly flagged.

---

## Automation Coverage Rules

- **Every `<verify>` block has an `<automated>` command.** Sole exceptions: checkpoint tasks + true operator-gated steps (DNS, license procurement, SES production access request).
- **Commands must complete in <60 s** (one-shot unit/CDK-synth-style tests). Long-running SES soak + EmailEngine 7-day soak are explicitly deferred to operator runbook.
- **No flaky network dependencies** in unit tests. All Bedrock / SES / EmailEngine / Gmail / Notion / Vertex calls are mocked.

---

## Plan 04-00 — Wave 0 Scaffold

| Task | Automated verify | Purpose |
|---|---|---|
| 00.1 workspaces + pnpm-workspace | `test -f services/ios-webhook/package.json && test -f services/ses-inbound/package.json && test -f services/emailengine-webhook/package.json && test -f services/email-triage/package.json && test -f services/email-sender/package.json && test -f services/emailengine-admin/package.json && echo OK` | All 6 service packages scaffolded |
| 00.2 contracts (4 new schemas) | `pnpm --filter @kos/contracts test -- --run 2>&1 \| tail -15` (asserts CaptureReceivedIosSchema + CaptureReceivedEmailForwardSchema + CaptureReceivedEmailInboxSchema + DraftReadySchema + EmailApprovedSchema + InboxDeadLetterSchema Zod-parse fixtures) | Typed event contracts |
| 00.3 migration 0012 SQL | `node scripts/validate-migration-syntax.mjs packages/db/drizzle/0012_*.sql` (pg-sql-parser; rejects syntax errors) | Migration is valid SQL before schema push |
| 00.4 withTimeoutAndRetry shared helper | `pnpm --filter @kos/service-shared test -- --run with-timeout-retry 2>&1 \| tail -10` (15+ tests: timeout, retry×2, final-failure dead-letter write, exponential backoff, exclude-approve-gate-failures) | Shared resilience primitive |
| 00.5 test fixtures (adversarial, duplicate, forwarded MIME) | `node -e "const f = require('./packages/test-fixtures/dist/index.js'); if (!f.ADVERSARIAL_INJECTION_EMAIL \|\| !f.DUPLICATE_EMAIL_FIXTURES \|\| !f.FORWARDED_EMAIL_MIME) process.exit(1); console.log('fixtures OK');"` | Fixtures resolvable + non-empty |

---

## Plan 04-01 — ios-webhook Lambda (CAP-02)

| Task | Automated verify | Purpose |
|---|---|---|
| 01.1 HMAC verifier unit tests | `pnpm --filter @kos/service-ios-webhook test -- --run hmac 2>&1 \| tail -10` (6 tests: valid sig 200, invalid sig 401, drift >300s 401, drift <300s 200, timingSafeEqual use, missing header 400) | HMAC implementation correct |
| 01.2 DynamoDB replay cache unit tests | `pnpm --filter @kos/service-ios-webhook test -- --run replay 2>&1 \| tail -10` (4 tests: first request accepted, duplicate signature 409, TTL set to now+600s, ConditionExpression correct) | Replay protection correct |
| 01.3 handler happy path | `pnpm --filter @kos/service-ios-webhook test -- --run handler 2>&1 \| tail -10` (5 tests: S3 put invoked with audio/{ulid}.m4a, capture.received published, capture_id is ULID, owner_id from env, idempotent on replay) | End-to-end handler behaviour |
| 01.4 CDK wiring | `pnpm --filter @kos/cdk test -- --run integrations-ios-webhook 2>&1 \| tail -15` (Lambda Function URL authType NONE, S3 PutObject IAM grant on blobs bucket, DynamoDB replay table exists with TTL enabled, ios-shortcut-webhook-secret grantRead) | CDK synth green |

---

## Plan 04-02 — ses-inbound Lambda (CAP-03)

| Task | Automated verify | Purpose |
|---|---|---|
| 02.1 MIME parser unit tests | `pnpm --filter @kos/service-ses-inbound test -- --run parse 2>&1 \| tail -10` (6 tests: forwarded-email MIME fixture → extracts From/Subject/Date/body; attachment stripping; multipart handling; Message-ID extraction; invalid MIME → 400) | MIME parsing correct |
| 02.2 handler happy path | `pnpm --filter @kos/service-ses-inbound test -- --run handler 2>&1 \| tail -10` (4 tests: S3 GetObject cross-region eu-west-1, Zod-validated detail, capture.received emitted with channel email-forward, idempotent on Message-ID) | End-to-end handler behaviour |
| 02.3 CDK wiring | `pnpm --filter @kos/cdk test -- --run integrations-ses-inbound 2>&1 \| tail -15` (S3 bucket kos-ses-inbound-euw1 exists with SES PutObject bucket policy, Lambda has cross-region s3:GetObject, SES receiving rule action includes LambdaAction + S3Action) | CDK synth green |

---

## Plan 04-03 — EmailEngine Fargate + emailengine-webhook + emailengine-admin (CAP-07 + INF-06)

| Task | Automated verify | Purpose |
|---|---|---|
| 03.1 emailengine-webhook handler | `pnpm --filter @kos/service-emailengine-webhook test -- --run 2>&1 \| tail -10` (5 tests: X-EE-Secret constant-time validated, Zod parse EmailEngine payload, capture.received emitted with channel email-inbox, missing header 401, ULID generated deterministically from message_id) | Webhook handler correct |
| 03.2 emailengine-admin Lambda | `pnpm --filter @kos/service-emailengine-admin test -- --run 2>&1 \| tail -10` (3 tests: proxies register-account to EmailEngine REST, proxies unregister-account, invalid command 400) | Admin lambda proxies correctly |
| 03.3 CDK wiring | `pnpm --filter @kos/cdk test -- --run integrations-emailengine 2>&1 \| tail -20` (FargateTaskDefinition cpu=1024 memory=2048 ARM64, desiredCount=1 maxHealthy=100 minHealthy=0, ElastiCache Serverless subnet group exists, log group /ecs/emailengine 30-day retention, all 5 emailengine-* Secrets Manager entries grantRead, emailengine-webhook Function URL IAM NONE) | CDK synth green |
| 03.4 operator runbook | `test -f .planning/phases/04-email-pipeline-ios-capture/04-EMAILENGINE-OPERATOR-RUNBOOK.md && grep -c "Gmail app password" .planning/phases/04-email-pipeline-ios-capture/04-EMAILENGINE-OPERATOR-RUNBOOK.md \| awk '{if ($1 >= 3) exit 0; else exit 1}'` | Runbook authored with required sections |

**Manual-only verifications (runbook, NOT automated)**:
- EmailEngine license procured before first deploy (Kevin confirms in `human_verification` on VERIFICATION.md).
- Gmail app passwords generated + seeded into both Secrets Manager entries.
- 7-day zero-IMAP-auth-failure soak — operator monitors CloudWatch log metric filter on pattern `"auth failure"` and confirms zero matches over 7 days. Automation-eligible post-deploy, not pre-deploy.

---

## Plan 04-04 — email-triage Lambda (AGT-05)

| Task | Automated verify | Purpose |
|---|---|---|
| 04.1 classify agent unit tests | `pnpm --filter @kos/service-email-triage test -- --run classify 2>&1 \| tail -10` (7 tests: Haiku tool_use classify urgent/important/informational/junk, prompt includes `<email_content>` wrap, system note verbatim, escapeEmailContent pre-escape on delimiter collision, Zod-validated output, fallback on model garbage) | Classify correct + injection guard |
| 04.2 draft agent unit tests | `pnpm --filter @kos/service-email-triage test -- --run draft 2>&1 \| tail -10` (5 tests: Sonnet tool_use draft only when classification=urgent, draft schema validated, `<email_content>` + `<email_headers>` wrap, reply_to matches sender, tone_notes included) | Draft correct |
| 04.3 idempotency unit tests | `pnpm --filter @kos/service-email-triage test -- --run idempotent 2>&1 \| tail -10` (3 tests: SELECT before INSERT on (account_id, message_id); double-process fixture → 1 row; ULID deterministic from message_id hash) | Idempotency guaranteed |
| 04.4 loadContext fallback | `pnpm --filter @kos/service-email-triage test -- --run context-loader-fallback 2>&1 \| tail -10` (3 tests: when @kos/context-loader resolves → loadContext called; when unresolvable → local fallback; kevinContext always loaded regardless) | Phase 6 graceful-degrade |
| 04.5 handler happy path | `pnpm --filter @kos/service-email-triage test -- --run handler 2>&1 \| tail -10` (6 tests: per-email path, scan-all-pending path, tagTraceWithCaptureId, agent_runs row with status=ok, draft_ready emitted, withTimeoutAndRetry wraps all Bedrock calls) | End-to-end handler |
| 04.6 CDK wiring | `pnpm --filter @kos/cdk test -- --run integrations-email-agents 2>&1 \| tail -15` (Lambda VPC config + bedrock grants for Haiku+Sonnet, NO ses:* grants, EventBridge rule scan_emails_now on kos.system, emailengine-webhook → email-triage rule on kos.capture email_inbox) | CDK synth green + IAM safety |

---

## Plan 04-05 — email-sender + dashboard-api Approve/Edit/Skip routes

| Task | Automated verify | Purpose |
|---|---|---|
| 05.1 dashboard-api approve route | `pnpm --filter @kos/service-dashboard-api test -- --run email-drafts-approve 2>&1 \| tail -10` (4 tests: 200 + email_send_authorizations row + email.approved emitted, invalid draft_id 404, draft already approved 409, auth middleware present) | Approve route correct |
| 05.2 dashboard-api edit/skip routes | `pnpm --filter @kos/service-dashboard-api test -- --run email-drafts-edit email-drafts-skip 2>&1 \| tail -10` (4 tests: edit updates body+subject+status, skip sets status=skipped, both emit SSE event, auth middleware present) | Edit/Skip routes correct |
| 05.3 email-sender handler | `pnpm --filter @kos/service-email-sender test -- --run 2>&1 \| tail -10` (6 tests: subscribes to email.approved, SES SendRawEmail called, email_drafts.sent_at updated, withTimeoutAndRetry wraps SES, NO bedrock grants in module, invalid authorization → no SES call) | Email-sender correct |
| 05.4 inbox route merges drafts | `pnpm --filter @kos/service-dashboard-api test -- --run inbox-drafts 2>&1 \| tail -10` (3 tests: /api/inbox includes email_drafts rows; dead-letter rows rendered as inbox_item; empty state returns [] not error) | Inbox merges |
| 05.5 CDK wiring | `pnpm --filter @kos/cdk test -- --run integrations-email-agents 2>&1 \| tail -15` (email-sender has ses:SendRawEmail, NO bedrock perms; dashboard-api has new /api/email-drafts routes wired to same Lambda) | CDK synth green + IAM safety |

---

## Plan 04-06 — Gate 3 verifier + Phase 4 E2E

| Task | Automated verify | Purpose |
|---|---|---|
| 06.1 verify-gate-3.mjs exists + typechecks | `node --check scripts/verify-gate-3.mjs && echo OK` | Script syntactically valid (mjs, ESM) |
| 06.2 verify-phase-4-e2e.mjs exists | `node --check scripts/verify-phase-4-e2e.mjs && echo OK` | Script syntactically valid |
| 06.3 Gate 3 idempotency test (offline mode) | `node scripts/verify-gate-3.mjs --mode=offline --test=idempotency 2>&1 \| tail -10` (runs against local Postgres + mocked Bedrock; asserts identical email fixture → 1 row) | Gate 3 idempotency works pre-deploy |
| 06.4 Gate 3 prompt-injection test (offline) | `node scripts/verify-gate-3.mjs --mode=offline --test=injection 2>&1 \| tail -10` (runs adversarial fixture through email-triage; asserts classification != urgent; asserts SES client never called; asserts `ceo@competitor.com` absent from drafts) | Gate 3 injection guard works |
| 06.5 Gate 3 approve-flow (offline) | `node scripts/verify-gate-3.mjs --mode=offline --test=approve-flow 2>&1 \| tail -10` (simulates Approve via dashboard-api; asserts email.approved emitted; email-sender invoked; SES mock called exactly once) | Gate 3 approve-flow |

**Manual-only verifications (runbook, NOT automated)**:
- EmailEngine 7-day zero-IMAP-auth-failure soak (Gate 3 criterion 3): operator monitors CloudWatch.
- Real adversarial email sent to kevin@tale-forge.app → pass through EmailEngine → email-triage classification matches offline expectation.
- SES production-access request approved (required for Gate 3 approve-flow real-live test).

---

## Cross-Plan Checks

| Check | Automated verify | Purpose |
|---|---|---|
| All EventBridge detail types registered | `pnpm --filter @kos/contracts test -- --run events-registry 2>&1 \| tail -10` (asserts capture.received + draft_ready + email.approved + email.sent + inbox.dead_letter + scan_emails_now all registered + have Zod schemas) | No typo in detail type strings |
| owner_id on every new RDS table | `grep -c "owner_id uuid" packages/db/drizzle/0012_*.sql \| awk '{if ($1 >= 3) exit 0; else exit 1}'` (3 new tables, each with owner_id) | D-13 locked decision honored |
| VPCE_BYPASS_ROLE_PATTERNS updated | `grep -c "KosEmailPipeline-IosWebhook\\*\\|KosEmailPipeline-SesInbound\\*" packages/cdk/lib/stacks/data-stack.ts \| awk '{if ($1 >= 2) exit 0; else exit 1}'` | Non-VPC Lambdas exempted from S3 deny policy |
| IAM: email-triage has NO ses:* | `pnpm --filter @kos/cdk test -- --run email-triage-iam-safety 2>&1 \| tail -5` (asserts test fails if email-triage role has any ses:* action) | Structural Approve gate |
| IAM: email-sender has NO bedrock:* | `pnpm --filter @kos/cdk test -- --run email-sender-iam-safety 2>&1 \| tail -5` | Separation of concerns |
| Phase 3 Inbox draft_reply item kind still renders | `pnpm --filter @kos/dashboard test -- --run inbox-client 2>&1 \| tail -5` (regression: Phase 4 adds real producer but Phase 3 render path unchanged) | No Phase 3 regression |

---

## Nyquist Compliance

- Every code-producing task has an `<automated>` verify command.
- Manual-only steps (DNS propagation, license procurement, Gmail app-password creation, SES production access, 7-day soak) are explicitly flagged in this matrix AND in the corresponding plan's `<verify>` block with `MANUAL_ONLY` marker.
- No `<automated>` command takes longer than 60 s.
- Wave 0 (04-00) is a prerequisite for all subsequent waves — explicitly sequenced.

**Compliance stamp**: `nyquist_compliant: true` flipped after Plan 04-00 scaffold lands (sets `wave_0_complete: true`) and all per-task `<verify>` blocks are confirmed populated with `<automated>` commands.

---

*Validation plan v1 — 2026-04-24*
