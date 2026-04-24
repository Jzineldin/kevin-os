# Phase 5 Discussion Log

**Date:** 2026-04-24
**Mode:** standard planning (Kevin asleep; orchestrator-recommended defaults locked)
**Planner model:** Claude Opus 4.7 (1M context)

---

## Invocation

`/gsd-plan-phase 5` run with orchestrator brief containing:
- 7 gray-area recommendations (Chrome bundling, Chrome distribution, Baileys library, Baileys session, LinkedIn poll enforcement, Discord ownership, Baileys read-only defense-in-depth, WhatsApp TOS disclosure)
- Cherry-pick structure (05-01/05-02 splittable, 05-03 independent, 05-04/05-05 independent, 05-06 independent, 05-07 Gate)
- Hard Gate 5 (WhatsApp Baileys) INSIDE Phase 5
- 13 artifacts to produce

---

## Gray-area decisions locked

All 7 orchestrator-recommended defaults accepted verbatim:

| # | Gray area | Decision | Rationale |
|---|-----------|----------|-----------|
| 1 | Chrome bundling | esbuild + copy-plugin (D-01) | Matches Phase 2 Lambda toolchain; MV3 service_worker as single file; simpler than Vite/crxjs |
| 2 | Chrome distribution | Unpacked-install-only (D-02) | Single-user; Web Store review/compliance zero-benefit |
| 3 | Baileys library | fazer-ai/baileys-api (D-03) | Active commits; well-maintained Dockerfile; fallback to PointerSoftware/Baileys-2025-Rest-API documented |
| 4 | Baileys session | Postgres-backed pluggable auth (D-06) | Baileys documented AuthenticationState interface; per-key rows; survives task restart cleanly |
| 5 | LinkedIn poll | chrome.alarms + visibility-API gate (D-07) | setInterval does NOT survive MV3 idle (Pitfall A); alarms + visibilityState='visible' + 30-min interval + jitter |
| 6 | Discord poll | Re-use Phase 10 Lambda (D-09) | Phase 10 Plan 10-04 already owns the handler; Phase 5 ships the Scheduler + contract |
| 7 | Baileys read-only | Defense-in-depth 5-layer (D-10) | Library wrapper + SG egress + CloudWatch metric + IAM boundary + soak log assertion |
| bonus | WhatsApp TOS | Dedicated 05-WHATSAPP-RISK-ACCEPTANCE.md (D-14) | Kevin signs literal text before Plan 05-04 executes; lives as a standalone artifact for lifecycle updates |

---

## Architectural catches

### Catch 1 — CAP-10 cross-phase ownership

Phase 10 Plan 10-04 owns `discord-brain-dump-listener`. Phase 5 Plan 05-06 ships only the Scheduler + contract. Either deploy order works:
- Phase 10 first → SSM param populated → Phase 5 Scheduler reads + wires correctly.
- Phase 5 first → Scheduler points at placeholder no-op ARN; Phase 10 updates SSM + Scheduler redeploys.

Documented in `05-06-DISCORD-CONTRACT.md`.

### Catch 2 — Migration 0017 vs Phase 6/7/8/10 chain

Phase 6 → 0012; Phase 4 → 0012→0013 (collision guard); Phase 7 → 0014; Phase 8 → 0015; Phase 10 → 0016; Phase 5 → **0017**. Wave 0 Task 3 includes a next-number guard: at execute-time, if 0017 is taken, bump to next free.

### Catch 3 — Baileys Fargate container secret ARN convention

Plan 05-04 Task 2 catches a subtle Fargate env pattern: our entrypoint.ts reads ARN env vars and fetches secret values at runtime (via SecretsManagerClient). BUT Fargate's `EcsSecret.fromSecretsManager()` injects the VALUE as env, not the ARN. We use plain `environment: { ARN: secret.secretArn }` instead, plus grant the task role `secretsmanager:GetSecretValue`. Correction applied inline.

### Catch 4 — WhatsApp Fargate egress SG

Whatsapp uses Anycast IPs — we can't enumerate them in an SG rule. Compensation: permissive 0.0.0.0/0:443+5222 egress PLUS CloudWatch metric + alarm on any BAILEYS_WRITE_REJECTED log line. Defense-in-depth catches misuse that domain-based SG could miss. If AWS Network Firewall is available in the deployment, domain-based blocking upgrades this; documented as future enhancement.

### Catch 5 — Baileys single-task invariant + pg advisory lock

Per Pitfall C in 05-RESEARCH.md, multiple tasks writing signal-protocol keys = corruption. Single-task invariant from D-05. Belt-and-braces: `use-postgres-auth-state.ts` wraps all writes in `pg_advisory_xact_lock(hashtext(ownerId))` — if someone accidentally sets `desiredCount: 2` in the future, writes still serialise.

### Catch 6 — LinkedIn Voyager URN monotonic-skip

Content-linkedin uses `evUrn > state.linkedin_last_event_urn` to skip already-seen messages. URNs are string-time-ordered in practice. If this assumption breaks, the 14-day observation catches runaway duplicates (duplicate capture_ids are downstream-idempotent but a duplicate-POST storm would be observable). Fallback logic: if POST /linkedin returns 409 dedupe signal, content script moves on.

### Catch 7 — Cherry-pick dependency arithmetic

Plan 05-02 depends on Plan 05-00 only. Plan 05-01 depends on Plan 05-00 only. Chrome-only subset = plans 05-00, 05-01, 05-02 — no LinkedIn/WhatsApp/Discord touched. Plan 05-06 depends only on 05-00 (contract) + SSM (operator-seeded). Plan 05-07 depends on 05-02, 05-03, 05-04, 05-05, 05-06 — the gate verifier is the last wave and only runs if all upstream plans landed.

---

## Wave structure

| Wave | Plans | Parallel? |
|------|-------|-----------|
| 0 | 05-00 | — |
| 1 | 05-01, 05-02 | Yes (no file overlap) |
| 2 | 05-03, 05-04 | Yes (05-03 is chrome-extension + Lambda; 05-04 is Baileys — no file overlap) |
| 3 | 05-05, 05-06 | Yes (05-05 is sidecar; 05-06 is Discord scheduler — no file overlap) |
| 4 | 05-07 | — |

Plan 05-03 consumes `services/chrome-webhook` pattern from 05-02 but does not modify 05-02's files. Depends_on includes 05-02 to guarantee wave ordering.

---

## Cherry-pick boundaries (for Kevin)

| Scenario | Plans | Risk | Outcome |
|----------|-------|------|---------|
| Lowest risk (CAP-04 only) | 05-00, 05-01, 05-02 | None | Chrome highlight live; no LinkedIn/WhatsApp/Discord |
| + LinkedIn (CAP-05) | + 05-03 | Medium (LinkedIn Q1 2026 ban escalation) | 14-day observation required before production-label |
| + Discord (CAP-10 polling half) | + 05-06 | None | Pending Phase 10 Plan 10-04 Lambda handler |
| Full Phase 5 (+ WhatsApp CAP-06) | + 05-04, 05-05, 05-07 | Medium-low (TOS risk, defense-in-depth) | Kevin signs 05-WHATSAPP-RISK-ACCEPTANCE.md; 7-day Gate 5 soak before production |

Kevin can invoke any subset via `/gsd-execute-phase 5 --plans <subset>`.

---

## Cost delta

- Baileys Fargate: ~$36/mo (1 vCPU ARM64 + 2GB) + $0/mo session storage (RDS reuses Phase 1 instance)
- Chrome extension: $0
- LinkedIn webhook Lambda + Scheduler-schedule: <$1/mo
- Discord Scheduler: <$1/mo (Phase 10 Lambda cost separate)
- verify-gate-5-baileys Lambda: <$1/mo
- Total Phase 5 delta: **~$36-38/mo** (covered by AWS credits for 12+ months)

---

## Deviations from recommended defaults

None. All 7 gray-area orchestrator recommendations accepted verbatim.

---

## Deferred items

None surfaced in planning — Phase 5 is self-contained within its cherry-pick structure.

---

## Handoff to Execute

Operator runs `/gsd-execute-phase 5 [--plans 00,01,02[,...]]`. Dependencies to pre-satisfy:
- Phase 2 live (triage + entity-resolver pipeline consumes capture.received regardless of kind).
- Phase 3 live (dashboard surfaces system_alerts cards; Baileys QR displayed in dashboard log view).
- For CAP-06 specifically: Kevin signs `05-WHATSAPP-RISK-ACCEPTANCE.md` + pins fazer-ai/baileys-api image digest + operator seeds 3 secrets (kos/baileys-webhook-secret, kos/baileys-database-url pointing at RDS Proxy, kos/sentry-dsn).
- For CAP-04: operator loads unpacked extension + pastes bearer + webhookUrl + hmacSecret into options page.
- For CAP-05: operator opens https://www.linkedin.com/messaging/ tab and keeps it focused for 30 min after landing plan 05-03.
- For CAP-10: operator seeds `aws ssm put-parameter --name /kos/discord/brain-dump-lambda-arn --type String --value <phase-10-arn-or-placeholder>`.

---

_Last updated: 2026-04-24 after Phase 5 planning._
</content>
</invoke>