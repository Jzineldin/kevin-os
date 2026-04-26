---
phase: 08-outbound-content-calendar
gate: 8
gate_name: Outbound Content + Calendar Safe
evidence_date: YYYY-MM-DD
status: TEMPLATE  # replace with PASS | FAIL | BLOCKING after run
---

# Gate 8 Evidence — Phase 8 Outbound Content + Calendar Safe

> Filled by operator after running
>   `node scripts/verify-gate-8.mjs --mode=live`
>   `node scripts/verify-phase-8-e2e.mjs --mode=live`
> AND completing all MANUAL_BLOCKED rows below. Mirrors the Phase 4
> 04-06-GATE-3-evidence-template + Phase 5 05-07-GATE-5-evidence-template
> patterns.

**Run by:** Kevin / operator
**Run at:** YYYY-MM-DDTHH:MM:SSZ
**Git SHA:** `<git rev-parse HEAD>`
**Deploy SHA:** `<same or deployed earlier>`
**Region:** eu-north-1 (RDS, Fargate, Step Functions, Secrets); us-east-1 (Bedrock)

## Pre-flight

- [ ] Worktree merged to master; CDK stacks deployed (KosCapture / KosAgents /
      KosIntegrations / KosObservability) at the Phase 8 commit.
- [ ] Plan 08-03 deployed manually (autonomous: false): Postiz Fargate task,
      publisher Lambda, dashboard /inbox routes, BRAND_VOICE.md filled.
- [ ] Secrets populated:
      `kos/postiz-api-key`,
      `kos/gcal-oauth-kevin-elzarka`,
      `kos/gcal-oauth-kevin-taleforge`,
      `kos/postiz-oauth-instagram`,
      `kos/postiz-oauth-linkedin`,
      `kos/postiz-oauth-tiktok`,
      `kos/postiz-oauth-reddit`,
      `kos/postiz-oauth-newsletter`.
- [ ] Postiz Cloud Map DNS resolves: `dig +short postiz.kos.local @<vpc-resolver>` → IP.
- [ ] `node scripts/verify-gate-8.mjs --mode=live` exited 0.
- [ ] `node scripts/verify-phase-8-e2e.mjs --mode=live` exited 0.

## Automated verifiers (script exit 0)

| Script | Mode | Status | Notes |
|--------|------|:------:|-------|
| `node scripts/verify-gate-8.mjs --mode=offline` | offline | [ ] PASS / FAIL | structural CDK + IAM grep |
| `node scripts/verify-gate-8.mjs --mode=live` | live | [ ] PASS / FAIL | adds RDS + ECS + Secrets probes |
| `node scripts/verify-gate-8.mjs --test=approve-gate --mode=live` | live | [ ] PASS / FAIL | zero orphan published rows + zero orphan executed mutations |
| `node scripts/verify-gate-8.mjs --test=prompt-injection --mode=live` | live | [ ] PASS / FAIL | adversarial topic created draft + no postiz_post_id |
| `node scripts/verify-gate-8.mjs --test=mutation-rollback --mode=live` | live | [ ] PASS / FAIL | archive-not-delete confirmed |
| `node scripts/verify-phase-8-e2e.mjs --mode=offline` | offline | [ ] PASS / FAIL | full SC1-SC7 offline proxy |
| `node scripts/verify-phase-8-e2e.mjs --mode=live` | live | [ ] PASS / FAIL | full SC1-SC7 live |

If a sub-verifier from Plan 08-06 Task 2
(verify-approve-gate-invariant.mjs / verify-prompt-injection-content-writer.mjs
/ verify-mutation-rollback.mjs) is missing, the gate verifier reports
PENDING — those scripts ship with Task 2 of Plan 08-06.

## Auto-Verified ROADMAP SCs

The gate verifier emits these PASS lines automatically; operator confirms
the run was actually live (not mock).

### SC 1 — 5-platform drafts via Step Functions fan-out

- [ ] State machine `ContentDraftingFanout` status=ACTIVE
- [ ] content-writer + content-writer-platform vitest PASS
- [ ] CDK integrations-content synth PASS
- Live evidence — synthetic topic submitted via `node scripts/submit-content-topic.mjs`:
  - Topic ID: ___
  - 5 content_drafts rows in 4 min: ___ / 5
  - All status='draft': YES / NO

### SC 3 — Google Calendar (both accounts) + entity context

- [ ] Secrets `kos/gcal-oauth-kevin-elzarka` + `kos/gcal-oauth-kevin-taleforge` exist
- [ ] calendar-reader vitest PASS
- [ ] CDK integrations-calendar synth PASS
- Live evidence:
  - calendar-reader agent_runs status='ok' last 24h: ___
  - calendar_events_cache rows for both accounts (kevin-elzarka / kevin-taleforge): ___ / ___

### SC 4 — Document version tracker

- [ ] document-diff vitest PASS
- Live evidence:
  - document-diff agent_runs status='ok' last 7d: ___
  - document_versions chain length for at least one tracked doc (avtal.pdf, etc.): ___

### SC 5 — Approve gate non-bypassable (invariant)

- [ ] Static IAM grep PASS (publisher: NO bedrock; content-writer-platform: NO postiz/ses;
      mutation-executor: NO bedrock/postiz/ses; mutation-proposer: NO postiz/ses)
- [ ] Live SQL: 0 orphan content_drafts rows in {scheduled, published}
- [ ] Live SQL: 0 orphan pending_mutations rows in {executed}

### SC 6 — Imperative-verb mutation pathway

- [ ] mutation-proposer + mutation-executor vitest PASS
- [ ] verify-mutation-rollback.mjs --verify PASS
- Live evidence:
  - Test capture text: "ta bort mötet imorgon kl 11"
  - pending_mutations.id created: ___
  - mutation_type: cancel_meeting (expected)
  - After Approve: calendar_events_cache.ignored_by_kevin=true; row STILL EXISTS (not deleted)
  - Raw mention_events / capture row STILL EXISTS

## Manual operator checks (MANUAL_BLOCKED — operator-only)

These are NOT failures of the auto gate — they're subjective measurements
the operator owns post-deploy. Phase 8 is "complete" when each row is
filled in here. **Plan 08-03 is `autonomous: false`** — these rows include
the manual-deploy steps.

### SC 2 — Publisher + Postiz round-trip (operator)

- [ ] BRAND_VOICE.md `human_verification: true` + non-template body
- [ ] Postiz Fargate first-boot:
  - [ ] container healthy (ECS DescribeServices: 1/1 ACTIVE)
  - [ ] admin user created at first-load
  - [ ] API key generated and stored in `kos/postiz-api-key`
  - [ ] `/api/mcp/{API_KEY}` reachable from publisher Lambda VPC
- [ ] Per-platform OAuth completed in Postiz UI:
  - [ ] Instagram (date: ___)
  - [ ] LinkedIn (date: ___)
  - [ ] TikTok (date: ___)
  - [ ] Reddit (date: ___)
  - [ ] Newsletter (Substack/Beehiiv) (date: ___)
- [ ] First real topic submitted → 5 drafts → 1 approved → published via Postiz:
  - Topic ID: ___
  - Draft approved: ___ (platform: ___)
  - postiz_post_id: ___
  - Verified live on platform: ___ (URL: ___)
  - Round-trip latency (Approve → published_at): ___ s

### SC 6 — Real mutation flow (operator)

- [ ] Voice capture "ta bort mötet imorgon kl 11" via Telegram / iOS Shortcut
- [ ] Inbox card appears within 60s
- [ ] Approve in dashboard
- [ ] Verified Google Calendar event UNCHANGED (still on calendar)
- [ ] Verified KOS calendar_events_cache.ignored_by_kevin=true
- [ ] Morning brief next day excludes the archived event from "today's calendar" section

### SC 4 — Document version flow (operator)

- [ ] Send avtal.pdf v3 to Damien
- [ ] Edit document → send v4
- [ ] Entity timeline for Damien shows both versions
- [ ] diff_summary populated and reads as Kevin-actionable text

## Cost verification (post-deploy, 7 days)

| Line item | Expected (mo) | Observed | Notes |
|-----------|--------------:|---------:|-------|
| Postiz Fargate (0.5 vCPU × 1 GB ARM64) | ~$19 | $___ | |
| content-writer Bedrock Sonnet (5 platforms × ~10 topics/wk) | ~$2.50 | $___ | |
| mutation-proposer Bedrock Sonnet | ~$2.70 | $___ | |
| document-diff Bedrock Haiku | ~$0.06 | $___ | |
| calendar-reader Lambda (5-min cadence) | ~$0.01 | $___ | |
| Step Functions Standard (fan-out) | <$0.01 | $___ | |
| Google Calendar API | $0 | $___ | |
| **Total add** | **~$24.60** | **$___** | within budget? YES / NO |

## Sign-off

- [ ] All 7 ROADMAP SCs verified (automated + manual)
- [ ] Approve-gate invariant passes (static + live)
- [ ] Prompt-injection resistance verified
- [ ] Mutation rollback confirms archive-not-delete
- [ ] Cost within budget
- [ ] BRAND_VOICE.md signed off

If COMPLETE: Phase 8 deliverables (CAP-09 calendar-reader, AGT-07 content-writer,
AGT-08 publisher, MEM-05 document-diff, mutation pathway) are now consumable
by Phase 9 (life-event memory, autonomous calendar manipulation extensions).

If INCOMPLETE, list specifically which SC rows are blocking + the next plan
that addresses each:

- SC___:
- SC___:

Operator signature: ___________________
Date: ___________________
