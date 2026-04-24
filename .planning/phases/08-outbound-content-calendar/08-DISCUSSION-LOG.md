# Phase 8 — Discussion Log

**Date:** 2026-04-24 (Kevin asleep — auto-mode planning run; all 7 orchestrator-recommended defaults accepted)
**Planner:** Claude Opus 4.7 (1M ctx)
**Branch:** phase-02-wave-5-gaps (writing directly per orchestrator instruction)

---

## Orchestrator brief recap

**Phase 8 scope:** AGT-07 (content-writer) + AGT-08 (publisher) + CAP-09 (Google Calendar) + MEM-05 (document versioning) + **imperative-verb mutation pathway (SC 6)** added 2026-04-23 from the failure case "ta bort mötet imorgon kl 11" silently saved as a new Command Center task.

**Depends on:** Phase 6 (loadContext + entity graph), Phase 4 (Approve-gate pattern + email-sender hook for MEM-05), Phase 5 soft (messaging channels — document gracefully degraded absence), Phase 7 (morning brief consumer).

**Hard invariants:**
- Approve gate non-bypassable via IAM split (D-26, SC 5)
- Google Calendar remains READ-ONLY (D-17)
- Archive-not-delete (Locked Decision #12) preserved across all mutation paths
- AnthropicBedrock direct SDK (Locked Decision #3 revision 2026-04-23)

---

## Gray-area decisions — all orchestrator defaults accepted

| # | Area | Orchestrator recommendation | Accepted |
|---|------|------------------------------|----------|
| 1 | BRAND_VOICE.md | New file at `.planning/brand/` with placeholder + human_verification gate (D-25 fail-closed) | YES (D-01) |
| 2 | Step Functions vs parallel Lambda | Step Functions Standard with Map state maxConcurrency=5 | YES (D-02) |
| 3 | Postiz deployment | Self-hosted Fargate per CLAUDE.md + EFS | YES (D-03) |
| 4 | CAP-09 OAuth | Per-account refresh tokens in Secrets Manager, bootstrap-gcal-oauth.mjs operator flow | YES (D-04) |
| 5 | Imperative coverage | Two-stage: regex → Haiku classifier → Sonnet target decide | YES (D-05) |
| 6 | Target resolution tiebreaker | Explicit reference first, timestamp fallback, disambiguation card if ambiguous | YES (D-06) |
| 7 | document_versions key | (recipient_email, doc_name) composite | YES (D-07) |
| 8 | Mutation vs content boundary | Separate tables + separate event contracts (D-08) | YES (D-08) |

**No deviations.** All 7 recommended defaults adopted verbatim.

---

## Notable design catches during planning

### 1. Mutation-proposer race with voice-capture (P-9)

Both consume `capture.received`. If voice-capture wins the race and writes a Command Center row before mutation-proposer writes `pending_mutations`, Kevin sees a duplicate: Inbox card (mutation) + Command Center task.

**v1 acceptance:** Non-destructive duplication. Approving the mutation archives the CC row (mutation-executor's `delete_task` path updates command_center_index by matching captureId). User experience is "slightly noisy" but never loses data.

**v1.1 future enhancement:** Add 3-second delay on voice-capture's Command Center insert path, giving mutation-proposer's 3-stage classifier (~5s) time to write first. Documented in 08-04 SUMMARY.

### 2. Step Functions Standard over Express

Initial instinct: Express is cheaper for short-lived workflows. But:
- Per-platform Sonnet drafting can reach p99 ~90s
- 5 platforms in parallel → one Lambda failure should NOT cause duplicate draft on retry
- Standard gives exactly-once; Express is at-least-once

Cost difference is negligible at KOS volume (~$0.07/year). Accepted Standard.

### 3. Google Calendar API v3 recurring event window

Midnight boundary edge: if the query is `[now, now + 24h]` and an event spans midnight at the boundary, it can be missed. Mitigation: fetch `[now - 1h, now + 48h]` and dedupe by `(event_id, updated_at)`.

### 4. Postiz MCP is Streamable HTTP, not SSE

Postiz docs evolved; MCP endpoint uses Streamable HTTP transport (per MCP v0.6+), not SSE. Response is a single JSON-RPC object OR a server-stream — for tool calls we consume as single response.

### 5. BRAND_VOICE.md bundled at build time via esbuild `--loader:.md=text`

Read file via fs.readFileSync at Lambda module scope in v1 (works for both test + Lambda bundle since esbuild resolves the relative path at bundle-time and inlines the file contents via a transformation). The package.json `build` script in Plan 08-00 will add this esbuild flag.

**Fail-closed invariant:** If `human_verification: false` (default), `getBrandVoice()` throws. content-writer-platform cannot draft. Kevin MUST fill in the file before first real use. Documented in D-25.

### 6. mutation-executor NEVER writes Google Calendar

Even `reschedule_meeting` only archives the old event in calendar_events_cache and notes that Kevin needs to manually move the event in Google. This is a deliberate design choice (D-17): the `calendar.readonly` OAuth scope means the infrastructure PHYSICALLY cannot write to Google even if the Lambda tried. Defense-in-depth.

### 7. Phase 5 incomplete handling (D-24)

Phase 5 (messaging channels) is not planned in this overnight run. content-writer's per-platform prompt gracefully degrades: when loadContext returns no WhatsApp/LinkedIn rows, the context block includes "_WhatsApp/LinkedIn context for this entity: not yet ingested (Phase 5 pending)_" rather than failing. No blocker.

### 8. Migration number 0015

Phase 6 reserves 0012; Phase 4 reserves 0012 or 0013 (collision bump); Phase 7 reserves 0014. Phase 8 targets 0015. Next-number guard in Plan 08-00 Task 3 bumps to 0016 if 0015 is taken at execution time (similar to Phase 4's guard against Phase 6).

### 9. IAM split — 6 dedicated Lambda roles

To enforce SC 5 Approve-gate non-bypass, Phase 8 creates 6 distinct RDS roles:
- `kos_content_writer_orchestrator` — read content_drafts only
- `kos_content_writer_platform` — insert/update content_drafts; bedrock grant
- `kos_publisher` — read drafts + authorizations; postiz secret; NO bedrock
- `kos_mutation_proposer` — read entity/calendar/drafts + insert pending_mutations; bedrock
- `kos_mutation_executor` — update pending_mutations + archive targets; NO bedrock, NO delete
- `kos_document_diff` — insert document_versions; bedrock Haiku only; s3 read
- `kos_calendar_reader` — insert calendar_events_cache; NO bedrock, NO writes

Nine total new RDS users (including content-writer orchestrator). Documented per-plan SQL snippets in each plan's SUMMARY output section.

### 10. Postiz Fargate first-boot is a human-action checkpoint

Plan 08-03 has `<task type="checkpoint:human-action">` because Postiz's first-boot admin setup + per-platform OAuth consent require Kevin to click through a browser UI. This is the ONE checkpoint in Phase 8. Everything else is automated.

---

## Open questions carried forward

1. Postiz AGPL self-host license confirmed — no procurement needed.
2. Google Calendar OAuth consent screen: "in testing" mode is fine for Kevin as single user; no app verification required.
3. Step Functions IAM for Lambda-invoking-Lambda across AZ — standard CDK grant pattern; no surprises.
4. EFS throughput mode for Postiz: start bursting, revisit if I/O bottleneck.
5. pdf-parse npm package name collision — Plan 08-00 pins `pdf-parse` ^1.1.1 (the original; not the typosquat `pdfparse`).
6. Mutation executor's Notion API scoping — uses existing `kos/notion-token` secret with page-level update; no new scopes needed because Notion's integration permissions are workspace-wide anyway.

---

## Cost landing

Phase 8 adds ~$24.60/mo steady state. Postiz Fargate dominates (~$19/mo); Bedrock calls are rare (~$5/mo combined across 4 agents). Google Calendar API is free. Step Functions Standard is trivial (<$0.01/mo).

Well within the $200-400/mo all-in budget. AWS credits absorb most of this for 12+ months.

---

## Plan inventory

| Plan | Wave | Tasks | Content |
|------|:----:|:-----:|---------|
| 08-00 | 0 | 5 | Scaffold — 7 services + contracts + migration 0015 + BRAND_VOICE seed + Postiz skeleton + fixtures |
| 08-01 | 1 | 3 | calendar-reader + context-loader extension + CDK schedule + OAuth bootstrap |
| 08-02 | 1 | 3 | content-writer + content-writer-platform + Step Functions Map + submit script |
| 08-03 | 2 | 3 | publisher + Postiz Fargate + dashboard routes + IAM safety (CHECKPOINT: human-action) |
| 08-04 | 2 | 3 | mutation-proposer (3-stage) + mutation-executor + voice-capture race-fix + dashboard routes + IAM safety |
| 08-05 | 3 | 2 | document-diff + entity-timeline extension + Haiku diff_summary |
| 08-06 | 4 | 2 | Gate verifiers + evidence template |

**Total:** 21 tasks across 7 plans. Waves: 0 → 1 (2 plans parallel) → 2 (2 plans parallel) → 3 → 4.

---

*Plans written 2026-04-24 — all 7 orchestrator recommendations accepted, no deviations.*
