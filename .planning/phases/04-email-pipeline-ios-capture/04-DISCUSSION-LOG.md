# Phase 4: Email Pipeline + iOS Capture — Discussion Log

**Phase:** 04-email-pipeline-ios-capture
**Planned:** 2026-04-24
**Branch:** phase-02-wave-5-gaps (direct main tree; no worktree)
**Planner:** Claude (Kevin asleep; orchestrator's "recommended defaults" locked per brief)

---

## Decisions Recorded

All 30 decisions (D-01..D-30) are locked in `04-CONTEXT.md` `<decisions>` section. This log captures the *reasoning* + tradeoffs + alternatives considered for each class of decision, so future replanning can revisit with context.

### Class 1: Ingress authentication (iOS webhook)

- **D-01 HMAC-SHA256 + timestamp replay**: Picked over JWT and signed URLs because (a) Kevin's iOS Shortcut has native Hash (HMAC SHA256) action — no external library needed, (b) Stripe's `t=,v1=` header pattern is the industry standard and copy-paste-reviewable, (c) single pre-shared secret is the right primitive for a single-user product. JWT would add signing-library complexity inside the Shortcut; signed URLs don't protect against a replay where the signed URL leaks.
- **D-02 Function URL auth=NONE**: Picked over API Gateway because Kevin pays for fewer moving parts. If WAF becomes needed in Phase 7+, Kevin migrates to CloudFront→Lambda with WAF attached; the HMAC layer in code remains unchanged.
- **D-03 DynamoDB replay cache**: Picked over in-memory Lambda caching (lost on restart) and Redis (EmailEngine Redis is a separate concern; multiplying Redis touches increases ops surface).

### Class 2: Email receiving region (SES)

- **D-04 SES inbound eu-west-1**: Forced choice — SES inbound is NOT in eu-north-1 (verified 2026-04-24 against AWS docs). Alternatives rejected: (a) moving all KOS to eu-west-1 = 6-month replatform + breaks Phase 2 wave-5-finalized infrastructure; (b) polling Gmail via IMAP instead of a receiving domain = slower + less composable + duplicates CAP-07 path for no benefit.
- **D-05 Subdomain of tale-forge.app**: Saves $12/yr + Kevin already owns the parent domain. Alternative `kevinos.app` would add DNS complexity and another SSL cert rotation concern.
- **D-06 New bucket in eu-west-1 + cross-region GET**: Lambda in eu-north-1 reads cross-region S3 for <100 MB/mo volume. Alternative: Lambda in eu-west-1 publishing to kos.capture in eu-north-1 via cross-region EventBridge = more latency + additional IAM complexity. Picked the simpler path.

### Class 3: EmailEngine deployment

- **D-07 Fargate + ElastiCache Serverless**: EmailEngine docs require persistent Redis + single instance. ElastiCache Serverless at ~$10/mo is cheaper than managing a t4g.micro Redis ($12.5/mo + ops). In-task Redis (sidecar container) rejected because Fargate task restarts lose Redis data = Gmail IMAP resync from scratch = Gmail rate-limits.
- **D-08 Image pinned by digest**: operator pins `postalsys/emailengine:latest` digest at deploy time to avoid silent major-version drift. Deferred as a manual operator step since we're file-writes-only in Phase 4 planning.
- **D-09 $99/yr license as hard prereq**: documented in runbook; without it, IMAP IDLE degrades to polling silently at day 14.
- **D-10 Gmail app passwords**: OAuth rejected because Google's verification process takes weeks for personal Gmail with `gmail.modify` scope. App passwords bypass 2FA safely given Secret Manager + KMS + VPC-only access.
- **D-11 X-EE-Secret header**: EmailEngine doesn't do HMAC on webhooks (confirmed against docs); static secret in a header, validated constant-time, is the shape. Different trust boundary from ios-webhook so intentionally a separate secret.
- **D-12 No EFS**: persistent state is all in Redis + Secrets Manager; no filesystem-scoped state to preserve.
- **D-13 Cloud Map internal DNS for admin Lambda**: Alternative NLB fronting EmailEngine rejected because ~$18/mo + operator complexity. Cloud Map Private DNS is free at this scale.

### Class 4: Email-triage agent

- **D-14 Haiku classify + Sonnet draft-for-urgent**: per AGT-05 spec. Both-Haiku rejected because Haiku miscounts nuance on long threaded emails (observed in Phase 2 entity-resolver's Haiku-disambig experiments before switching to Sonnet). Both-Sonnet rejected for cost — 10x Haiku, ~5% urgent rate doesn't need Sonnet on informational/junk classifies.
- **D-15 Model IDs pinned**: EU inference profiles (`eu.anthropic.claude-*`). Non-EU profiles rejected because Kevin's email stream includes EU personal data; EU inference = data stays in EU.
- **D-16 `<email_content>` delimiters + system note + escapeEmailContent**: Anthropic's official guidance verbatim. Alternative approaches considered: (a) JSON-only user input wrapping — rejected because emails are naturally prose; (b) separate prompt-sanitization Lambda — rejected as over-engineering for the 94%+ efficacy of the delimiter + tool_use combo.
- **D-17 Composite (account_id, message_id) idempotency**: Message-ID alone is technically unique per RFC 5322, but Gmail's "forwarded" headers sometimes leak the original Message-ID into a forwarded capture. Composite key avoids the rare cross-account collision.
- **D-18 Structural Approve gate via IAM split**: email-triage has NO `ses:*`. email-sender has NO `bedrock:*`. This is defense-in-depth: even if the triage Lambda is compromised at the code level (prompt injection bypass, auth bypass, etc.), it cannot send email. The CDK tests assert both negatives.
- **D-19 Runtime `require.resolve` for @kos/context-loader**: Phase 6 may or may not be deployed when Phase 4 lands. Two alternatives rejected: (a) hard-require Phase 6 before Phase 4 = breaks ROADMAP's parallel-with-Phase-3 intent; (b) separate "email-triage-lite" Lambda that gets replaced = maintenance cost. Runtime resolve + local fallback is the cleanest.
- **D-20 Entity resolution by email column**: lightweight; respects Phase 2's three-stage resolver ecosystem by NOT duplicating the LLM disambig path.

### Class 5: Email drafts UI surface

- **D-21 Activate Phase 3's dormant `draft_reply` item kind**: Phase 3 Plan 03-09 already wired the render code but had no producer. Phase 4 adds the producer + merges in /api/inbox. Alternative: entirely new /email-drafts page in dashboard rejected because (a) the Inbox is already where Kevin reviews ambiguous items, (b) duplicate nav paths are friction.
- **D-22 dashboard-api Route Handlers, not Server Actions to Lambda**: keeps the Bearer-token middleware perimeter consistent. Server Actions would need their own auth layer; fragmenting the auth story is a known Next.js footgun.
- **D-23 Edit does NOT auto-approve**: Kevin's edit intent is "let me fix the tone"; auto-approving after edit would bypass his natural pause. Alternative "Approve+Edit" button rejected as ambiguous UX.

### Class 6: Tool-call resilience

- **D-24 Shared withTimeoutAndRetry**: specified in ROADMAP SC5. 10s timeout + 2 retries + exponential backoff + dead-letter is the industry norm for Bedrock calls. The 4 explicit "tool" surfaces (Bedrock, Notion, EmailEngine, SES) all route through the same helper — structural consistency.
- **D-25 Dead-letter to Inbox, NOT Telegram**: Phase 1 locked a hard 3-msg/day Telegram cap. System-internal failures shouldn't eat Kevin's cap. Inbox card is discoverable when Kevin is already reviewing Inbox.

### Class 7: AUTO-02 split

- **D-26 Rule only, no schedule in Phase 4**: ROADMAP explicitly splits AUTO-02 across Phase 4 (agent) and Phase 7 (schedule). Plan 04-05 creates the `scan_emails_now` rule on kos.system; Phase 7 adds `EventBridge Scheduler` with timezone Europe/Stockholm cron targeting the same detail-type. Zero Phase 4 code change when Phase 7 ships.
- **D-27 Operator trigger script**: lets Kevin test the end-to-end flow pre-Phase-7. Also the emergency "catch up after EmailEngine downtime" path.

### Class 8: Cost discipline

- **D-28 ≤$60/mo envelope**: each line item enumerated in CONTEXT. No surprises at bill-pay time.
- **D-29 No EFS / ALB / additional NAT**: every one of those would add >$20/mo for marginal value. Phase 2 wave-5 NAT already in place covers all PRIVATE_WITH_EGRESS Lambdas.

### Class 9: Observability

- **D-30 Sentry + Langfuse uniform**: every new Lambda follows the Plan 02-10 pattern. Deterministic capture_id via hash(account_id + message_id) means email-triage retries tag the same Langfuse trace — one observable flow even under failure/retry.

---

## Alternatives Considered and Rejected

| Alternative | Rejected because |
|---|---|
| Migrate all KOS to eu-west-1 to eliminate SES region split | 6-month replatform; breaks Phase 2 wave-5 infrastructure; no operational benefit for single-user |
| Gmail OAuth instead of app passwords | Google verification review = weeks; no security benefit at single-user scale |
| Pre-computed ULID (deterministic hash→ULID) for iOS captures | Adds complexity; replay cache handles dedup; not worth it |
| Use EmailEngine outbound SMTP instead of SES SendRawEmail | Loses the `email_send_authorizations` audit trail; SES credits available |
| Single "email-agent" Lambda doing both triage + send | Bypasses the structural Approve gate; rejected per locked decision |
| JWT for iOS auth | Signing library overhead in Shortcut; HMAC is native |
| In-memory replay cache | Lost on Lambda cold start; DDB at $0.10/mo is right |
| New domain kevinos.app | $12/yr + DNS management; subdomain is cleaner |
| Auto-retry from Inbox UI for dead letters | Phase 7+ UX work; v1 provides CLI hint only |
| Bedrock models via us-east-1 profile | EU personal data must stay in EU |
| EmailEngine + Redis in single Fargate container | Restart loses IMAP sync state |
| EmailEngine multi-task Service | Explicitly forbidden by EmailEngine docs — corrupts Redis |
| Phase 4 adds every-2h scheduler | ROADMAP explicitly moves the schedule to Phase 7 |
| Dashboard uses Server Actions to invoke email-triage directly | Bypasses Bearer middleware; fragments auth perimeter |
| Embed Phase 6 @kos/context-loader hard-dep in Phase 4 | Couples Phase 4 completion to Phase 6 deploy order |

---

## Open Questions (Deferred)

None that block Phase 4 execution. Relevant downstream concerns:

1. **Phase 7 scheduler wiring** — Phase 4 creates the rule, Phase 7 adds the cron. No Phase 4 code change needed.
2. **Phase 6 `@kos/context-loader` activation** — transparent when Phase 6 ships; Phase 4 runs in fallback mode in the meantime.
3. **Phase 8 document version tracker** — will need to consume `email_drafts.sent_at` + sender+recipient attachments; Phase 4's schema supports future attachment columns (nullable additions).
4. **SES production access request timing** — operator-owned; Gate 3 criterion 4 live-test needs this. Pre-production can use verified-recipient-only sandbox for partial coverage.

---

## Deferred Items Quick List

1. EmailEngine image digest pinning (operator task at deploy).
2. MX record automation via Route 53 (pending DNS migration).
3. SES outbound production access request.
4. Live-mode Gate 3 tests in `verify-gate-3.mjs` (stubs present; operator fills post-deploy).
5. Automatic retry-from-UI for dead-letter cards.
6. Per-account email-triage prompt tuning (tale-forge vs personal).
7. EmailEngine subscribing to multiple Gmail labels beyond INBOX.
8. Gmail OAuth migration if Google deprecates app passwords.
9. WAF attachment for ios-webhook Function URL.

---

## Plan Inventory

| Plan | Wave | Deps | Files | Summary |
|---|---|---|---|---|
| 04-00 | 0 | — | 40 | Scaffold 6 services, contracts, migration, withTimeoutAndRetry, fixtures |
| 04-01 | 1 | 00 | 9 | CAP-02 ios-webhook Lambda + HMAC + replay cache + CDK + VPCE bypass update |
| 04-02 | 1 | 00 | 7 | CAP-03 ses-inbound Lambda + MIME parser + cross-region S3 + CDK + runbook |
| 04-03 | 2 | 00 | 10 | CAP-07 EmailEngine Fargate + ElastiCache + 2 Lambdas + Cloud Map + runbook |
| 04-04 | 3 | 00, 02, 03 | 14 | AGT-05 email-triage classify + draft + context fallback + idempotency + CDK |
| 04-05 | 3 | 00 | 16 | AGT-05 email-sender + 3 dashboard routes + /api/inbox + CDK + scan trigger |
| 04-06 | 4 | 00–05 | 3 | Gate 3 + Phase 4 E2E verifiers + evidence template |

Total: 7 plans, ~99 files, ~3200 lines of new code at execution (mostly tests).

---

*Discussion log authored 2026-04-24. Kevin asleep; defaults locked per orchestrator brief. No live discussion occurred.*
