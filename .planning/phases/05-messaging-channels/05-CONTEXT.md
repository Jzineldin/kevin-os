# Phase 5: Messaging Channels — Context

**Gathered:** 2026-04-24
**Status:** Ready for planning
**Branch:** phase-02-wave-5-gaps (writing directly to main tree, no worktree)

<domain>
## Phase Boundary

Phase 5 wires three additional capture surfaces plus the Discord fallback into KOS:

1. **CAP-04 Chrome MV3 highlight** — `"Send to KOS"` context menu on any highlighted text POSTs to webhook with Bearer + HMAC; capture appears in Inbox within 5 s. Low-risk. Splittable.
2. **CAP-05 LinkedIn DM ingestion (defensive posture)** — Voyager API polled from within Kevin's logged-in LinkedIn tab, tab-focus-gated, ≤1 poll / 30 min, 2-15 s randomized delays, silent-fail to Dashboard alert on 401/403, 14-day observation with zero "unusual activity" warnings. LinkedIn Q1 2026 ban escalation = medium risk.
3. **CAP-06 Baileys WhatsApp (read-only)** — `fazer-ai/baileys-api` Fargate task on existing `kos-cluster`, session keys persisted in RDS, strict read-only defense-in-depth, 7-day zero-write soak (Hard Gate 5 — INSIDE Phase 5), graceful-degrade on task kill. TOS-risk = medium-low (read-only, personal number).
4. **CAP-10 polling half** — EventBridge Scheduler cron(*/5 * * * ? *) entry targeting a Phase-10-owned `discord-brain-dump-listener` Lambda. Phase 5 ships the scheduler + capture.received contract; Phase 10 Plan 10-04 ships the Lambda handler.

**Cherry-pick structure:** Plans 05-01 + 05-02 (CAP-04 Chrome highlight) can ship alone. Plans 05-03 (LinkedIn) and 05-04 + 05-05 (Baileys) are gated behind explicit risk acceptance and can be deferred indefinitely. Plan 05-06 (Discord scheduler) is independent of the Chrome/LinkedIn/WhatsApp stack.

**In scope:**
- `apps/chrome-extension/` MV3 package — manifest.json, background service_worker, content scripts, options page.
- `services/chrome-webhook` Lambda — accepts POST with Bearer + HMAC; mirrors the `telegram-bot` gate pattern; emits `capture.received` with `channel: 'chrome'`, `kind: 'chrome_highlight'`.
- `services/linkedin-webhook` Lambda — accepts POSTs from the LinkedIn content script; same auth gate; emits `capture.received` with `channel: 'linkedin'`, `kind: 'linkedin_dm'`.
- LinkedIn content script — matches `/messaging/*` only; visibility-gated `chrome.alarms`-based 30-min timer; 2-15 s jittered sub-request delays; 401/403 silent-fail with Dashboard alert via `kos.system / system_alert`.
- `services/baileys-fargate` — Fargate TaskDef (1 vCPU, 2 GB, ARM64) on `kos-cluster`, `fazer-ai/baileys-api` image + thin wrapper entrypoint (read-only enforcement at library call-site).
- `services/baileys-sidecar` Lambda — consumes Baileys container webhooks per incoming message; emits `capture.received` with `channel: 'whatsapp'`, `kind: 'whatsapp_text'` or `'whatsapp_voice'`. Voice routes through existing transcribe-starter pipeline unchanged.
- `services/discord-polling-schedule` — pure CDK wiring (EventBridge Scheduler → Phase-10 Lambda stub); Phase 5 delivers the rule + contract.
- `packages/db/drizzle/0017_phase_5_messaging.sql` — `whatsapp_session_keys` (Baileys signal-protocol keys, JSONB value column + composite PK), `system_alerts` (id, owner_id, source, severity, message, created_at, ack_at), `sync_status` (channel, last_healthy_at, queue_depth, paused_until).
- `packages/contracts` — `ChromeHighlightCaptureSchema`, `LinkedInDmCaptureSchema`, `WhatsappIncomingCaptureSchema`, `SystemAlertSchema`.
- `services/verify-gate-5-baileys` + `scripts/verify-phase-5-e2e.mjs` — Gate 5 measurable criteria + ROADMAP SC 1-5 checks.
- `05-WHATSAPP-RISK-ACCEPTANCE.md` — Kevin literally signs this before 05-04 executes.

**Out of scope:**
- Actual Fargate deploys / Chrome extension publishes / WhatsApp QR scans (all operator runbook steps).
- Discord Lambda handler (owned by Phase 10 Plan 10-04). Phase 5 ships the scheduler + capture.received contract only.
- Chrome Web Store submission (unpacked-only for single-user per D-02).
- LinkedIn outbound automation (explicitly prohibited in PROJECT.md Out of Scope).
- WhatsApp Business Cloud API (personal number, cannot register).
- Evolution API (prohibited per CLAUDE.md — too heavy, multi-tenant SaaS).
- Chrome extension bundling via Vite / @crxjs / webextension-toolbox (D-01 chose esbuild+copy-plugin).
- EFS for Baileys session state (D-06 chose RDS).
- Multiple concurrent Baileys tasks (single-task invariant; concurrent writes to session keys corrupt them).
- New CDK synths mutating cloud state.

</domain>

<decisions>
## Implementation Decisions

Kevin is asleep. All 7 gray areas resolved with the orchestrator's recommended defaults. Source artefacts:
- `<artifacts_to_produce>` recommended defaults from the orchestrator brief
- CLAUDE.md (Baileys `fazer-ai/baileys-api` vs `PointerSoftware/Baileys-2025-Rest-API`; Chrome MV3 service_worker string; LinkedIn Q1 2026 ban escalation; WhatsApp TOS; Baileys single-task)
- PROJECT.md Locked Decision #3 REVISED (AnthropicBedrock direct; no Agent SDK)
- Phase 2 patterns (grammY webhook Lambda, API Gateway v2 HTTP, secret_token gate, wrapHandler + Sentry + Langfuse)
- Phase 4 patterns (EmailEngine Fargate on `kos-cluster`, Cloud Map internal DNS, 2 Lambdas for admin+webhook, operator runbook)

### Chrome extension bundling + distribution

- **D-01 [LOCKED — recommended default]**: **esbuild + copy-plugin** for Chrome extension bundling. Matches Phase-2 Lambda bundling toolchain (already proven in `services/telegram-bot/esbuild.config.mjs`); simpler than @crxjs/vite; MV3 service_worker bundles to a single file. Output: `apps/chrome-extension/dist/{manifest.json, background.js, content-highlight.js, content-linkedin.js, options.html, options.js}`. Not @crxjs/vite-plugin (adds another build tool to the monorepo without benefit), not webextension-toolbox (legacy).
- **D-02 [LOCKED]**: **Unpacked-install only** — single-user personal tool, no Chrome Web Store review/compliance overhead, no public listing. Kevin loads `apps/chrome-extension/dist/` via `chrome://extensions → Developer mode → Load unpacked`. Options page seeds Bearer + Webhook URL + HMAC secret once; `chrome.storage.local` persists them.

### Baileys library + session persistence

- **D-03 [LOCKED — recommended default]**: **`fazer-ai/baileys-api`** (Docker Hub: `ghcr.io/fazer-ai/baileys-api:latest` or equivalent). More active commits recently per CLAUDE.md; well-maintained dockerfile; exposes REST + webhook. Documented fallback: `PointerSoftware/Baileys-2025-Rest-API` — swap image reference at deploy time if upstream goes stale. NOT `Evolution API` per CLAUDE.md (too heavy, multi-tenant).
- **D-04 [LOCKED]**: Image pinned by digest at deploy time (operator grabs current digest into `packages/cdk/lib/stacks/integrations-baileys.ts` as a const; runtime-matched against env var `BAILEYS_IMAGE_DIGEST`). Image runs in `PRIVATE_WITH_EGRESS` subnets with tight SG egress (only `web.whatsapp.com` + AWS endpoints; see D-09).
- **D-05 [LOCKED]**: Task spec — 1 vCPU, 2 GB, ARM64 FARGATE platform 1.4.0, `desiredCount: 1`, `maxHealthyPercent: 100`, `minHealthyPercent: 0`. Single-task invariant is non-negotiable: concurrent writes to Baileys signal-protocol session keys corrupt them. Mirrors EmailEngine pattern from Plan 04-03.
- **D-06 [LOCKED — recommended default]**: Session persistence = **Postgres-backed custom Baileys auth provider** (not JSONB column, not EFS). Baileys has a documented pluggable auth interface (`AuthenticationState` + `SignalKeyStore`); session keys serialize to multiple rows keyed by signal-protocol key ID. Migration 0017 creates `whatsapp_session_keys(owner_id, key_id text, key_type text, value_jsonb jsonb, updated_at timestamptz)` with `PRIMARY KEY (owner_id, key_id)`. Custom entrypoint wraps `fazer-ai/baileys-api` startup, injecting a PG-backed auth state before the library connects to WhatsApp Web. EFS would add a persistence path we don't need; single-row JSONB would force ALL key operations into one row (hot-row contention + serialization penalty).

### LinkedIn poll enforcement

- **D-07 [LOCKED — recommended default]**: **`chrome.alarms` + visibility-API gate**. `chrome.alarms.create('linkedin-poll', { periodInMinutes: 30 })` (service_worker-safe; `setInterval` does NOT survive MV3 idle termination — Pitfall A documented in 05-RESEARCH.md). The alarm handler in `background.ts` sends a message to the LinkedIn content script; the content script checks `document.visibilityState === 'visible'` AND `Date.now() - lastPollAt > 30 * 60 * 1000` before executing the Voyager fetch. If tab is hidden or last-poll is too recent, skip silently. Zero polls in background.
- **D-08 [LOCKED]**: Sub-request delays inside a single poll = `await sleep(randomInt(2000, 15000))` between each Voyager call (conversations list → thread reads). Jittered, not deterministic. Max concurrent: 1.

### Discord polling ownership

- **D-09 [LOCKED — recommended default]**: **Re-use Phase 10's planned `discord-brain-dump-listener` Lambda**. Phase 5 ships the EventBridge Scheduler entry (`cron(0/5 * * * ? *)` UTC since Discord messages are time-neutral — no timezone needed) + the `capture.received` contract for `kind: 'discord_text'`. The actual handler lives in Phase 10 Plan 10-04 (already enumerated in ROADMAP). At Phase 5 execute time, the Lambda ARN is a placeholder; Phase 10 Plan 10-04 swaps it for the real ARN. If Phase 10 runs first, Phase 5 wires the scheduler to the existing Lambda. Defer-safe either way.

### Baileys read-only enforcement (defense-in-depth)

- **D-10 [LOCKED — recommended default + D-11 + D-12 + D-13]**: Five concurrent mechanisms (any one can fail; four others must stay green):
  - **(a) Library-level wrapper** — custom `makeWASocket` wrapper in `services/baileys-fargate/src/wa-socket.ts` rejects `sendMessage`, `updateStatus`, `groupCreate`, `groupParticipantsUpdate`, `chatModify`, `readMessages`, `sendPresenceUpdate` at call-site by throwing + logging to CloudWatch with log line `BAILEYS_WRITE_REJECTED` + incrementing the `whatsapp_write_calls_total` metric.
  - **(b) Security Group egress lock** — Baileys Fargate task SG allows outbound only to WhatsApp endpoints (`*.whatsapp.net`, `web.whatsapp.com`, `g.whatsapp.net`, `mmg.whatsapp.net`, `media.whatsapp.net`) + AWS VPC endpoints. No other outbound internet. Enforced via a VPC egress-control pattern: SG attached to a VPC endpoint prefix list where possible; for WhatsApp's Anycast IPs a permissive egress is unavoidable on :443 + :5222, but domain-restricted via AWS Network Firewall (if present — fallback: IP-based `0.0.0.0/0:443` with a CloudWatch alert on unusual byte counts).
  - **(c) CloudWatch custom metric** — `KOS::Baileys::whatsapp_write_calls_total`. EMF emit from the wrapper on every rejected write attempt. A CloudWatch alarm fires on `> 0` over 1 minute → SNS topic `kos-baileys-write-alarm` (silent; writes a `system_alert` row via alarm Lambda; NO Telegram ping per notification-cap invariant).
  - **(d) IAM boundary** — Baileys Fargate task role has NO outbound internet-mutating permissions, NO Bedrock grant, NO SES grant, NO DynamoDB write grant beyond session_keys. Only `secretsmanager:GetSecretValue` on `kos/baileys/*` + `rds-data:Execute*` on `whatsapp_session_keys` + `ssm:GetParameter` for runtime config + `cloudwatch:PutMetricData`. Grep-test in CDK synth forbids any `*:Send*` or `*:Update*` outside session_keys.
  - **(e) Runtime log assertion** — soak Lambda `services/verify-gate-5-baileys` greps CloudWatch logs for `sendMessage` / `updateStatus` / `BAILEYS_WRITE_CALL` patterns every day; 7 consecutive zero-hit days → Gate 5 criterion #1 passes.

### WhatsApp TOS risk disclosure

- **D-14 [LOCKED — recommended default]**: **Dedicated `.planning/phases/05-messaging-channels/05-WHATSAPP-RISK-ACCEPTANCE.md`**. Kevin literally signs this (human_verification checkpoint in Plan 05-04) before Baileys-in-prod deploy. Captures: TOS-risk medium-low (personal number, read-only, zero write ops), fallback-to-Telegram-primary path if WhatsApp revokes session, snapshot of Baileys session key structure for post-incident forensics. Separate from inline risk commentary because the risk-acceptance lives over the codebase lifecycle — if Kevin later rotates numbers or WhatsApp changes TOS enforcement, we update this file in-place rather than hunting through plans.

### Cherry-pick boundaries

- **D-15 [LOCKED]**: Plans 05-01 + 05-02 ship CAP-04 (Chrome highlight) with ZERO dependencies on LinkedIn / WhatsApp. Kevin can run `/gsd-execute-phase 5 --plans 00,01,02` to land Chrome-highlight-only. Plans 05-03 (LinkedIn), 05-04 (Baileys CDK), 05-05 (Baileys sidecar Lambda) are each independently deferrable. Plan 05-06 (Discord scheduler) depends only on the `discord-brain-dump-listener` Lambda ARN being resolvable (Phase 10 or a placeholder). Plan 05-07 (Gate verifier + soak) runs only when plans 05-04 + 05-05 have landed.

### Compatibility with existing architecture

- **D-16 [LOCKED]**: No new Bedrock usage in Phase 5 (capture-layer only). When the triage Lambda processes the new `capture.received` kinds, it goes through the Phase 2 pipeline unchanged — no Phase 5 code calls Bedrock. This is structural (capture is the first EventBridge hop; triage is downstream).
- **D-17 [LOCKED]**: Every new Lambda ships with the Phase 2 shared stack: `wrapHandler` from `services/_shared/sentry.ts`, `setupOtelTracingAsync` + `tagTraceWithCaptureId` from `services/_shared/tracing.ts`, `ulid()` from `@kos/contracts/src/ulid.ts`, `initSentry()` at module scope. Mirrors Phase 4 pattern.
- **D-18 [LOCKED]**: Migration `0017_phase_5_messaging.sql` guards against Phase-6/7/8/10 collision (which reserve 0012→0016). At execute-time, Plan 05-00 Task 3 checks the next-available number and bumps if filesystem state shows 0017 already taken.
- **D-19 [LOCKED]**: All new RDS tables carry `owner_id` per Locked Decision #13. `whatsapp_session_keys.owner_id` → Kevin's user ID by default; `system_alerts.owner_id` same; `sync_status` is effectively singleton-per-channel for a single-user system but carries `owner_id` for forward-compat.

### Graceful degradation invariants

- **D-20 [LOCKED]**: Kill Baileys task → messages queue in Baileys' internal Redis-like store (library-native); on recovery, batch-process. Soak Lambda observes `sync_status.queue_depth` over 7 days. On recovery, `services/baileys-sidecar` emits a single `kos.output / sync_resumed` event that the Phase 7 morning-brief agent reads and surfaces as prose in the next daily brief (`"WhatsApp sync paused 4h, 12 messages queued"`). NO Telegram fire-alarm at the moment of task death (per notification cap).
- **D-21 [LOCKED]**: Kill Chrome extension (browser closed, extension disabled) → Dashboard Inbox shows a `system_alert` card sourced from `sync_status.paused_until` + last healthy timestamp. Next daily brief mentions downtime in prose. No Telegram.
- **D-22 [LOCKED]**: Kill Discord poll (bot token revoked, channel archived) → `discord-polling-schedule` Lambda (Phase 10) writes `system_alert` + updates `sync_status` for channel `discord`. Next daily brief picks up from there.

### LinkedIn safety rails

- **D-23 [LOCKED]**: Voyager cookies NEVER leave the browser. The LinkedIn content script fetches `https://www.linkedin.com/voyager/api/messaging/conversations` with `credentials: 'include'` (browser sends cookies automatically); the Voyager response is then POSTed to `linkedin-webhook` Lambda with ONLY the extracted message payload (no cookies, no session headers, no CSRF tokens). Server-side never sees or stores any LinkedIn session data.
- **D-24 [LOCKED]**: On Voyager 401/403: content script disables polling for 24 h (sets `chrome.storage.local.linkedin_disabled_until = Date.now() + 24*3600*1000`), writes a `system_alert` via the linkedin-webhook Lambda's `/alert` path, no retry. Manual re-enable via options page.
- **D-25 [LOCKED]**: 14-day observation — `scripts/verify-linkedin-observation.mjs` counts `system_alerts` where `source='linkedin' AND severity IN ('auth_fail','unusual_activity')` over the last 14 days; PASS if zero. Evidence template in `05-VALIDATION.md` records each day's snapshot.

</decisions>

<artifact_traceability>
## Source → Plan Mapping

| Source Item | Coverage | Plan |
|-------------|----------|------|
| GOAL: WhatsApp all chats read-only | COVERED | 05-04 (Fargate) + 05-05 (sidecar Lambda) |
| GOAL: LinkedIn DMs via Voyager | COVERED | 05-03 (content script + webhook Lambda) |
| GOAL: Chrome highlights | COVERED | 05-01 (extension) + 05-02 (webhook Lambda) |
| GOAL: Discord fallback polling | COVERED | 05-06 (scheduler + contract) |
| GOAL: 7-day WhatsApp soak gate | COVERED | 05-07 (Gate 5 verifier) |
| GOAL: LinkedIn tab-focus-only | COVERED | 05-03 D-07 |
| REQ CAP-04 | COVERED | 05-01 + 05-02 |
| REQ CAP-05 | COVERED | 05-03 |
| REQ CAP-06 | COVERED | 05-04 + 05-05 |
| REQ CAP-10 (polling half) | COVERED | 05-06 |
| CONTEXT D-01..D-25 | COVERED | all plans reference their D-XX in action text |
| RESEARCH: MV3 service_worker lifecycle | COVERED | 05-01 + 05-03 |
| RESEARCH: Baileys pluggable auth | COVERED | 05-04 |
| RESEARCH: WhatsApp TOS risk | COVERED | 05-04 + 05-WHATSAPP-RISK-ACCEPTANCE.md |
| RESEARCH: Voyager API shape | COVERED | 05-03 |
| HARD GATE 5 (WhatsApp) | COVERED | 05-07 |

No MISSING items. No DEFERRED items silently dropped.
</artifact_traceability>

<open_questions>
None for planning. Execution-time open questions (documented in plans):
1. Final Baileys image digest (operator pins at deploy).
2. WhatsApp endpoint domain allowlist for SG egress — verified in Plan 05-04 operator runbook.
3. LinkedIn Voyager API pagination cursor name (Plan 05-03 includes runtime probe on first call).

</open_questions>
</content>
</invoke>