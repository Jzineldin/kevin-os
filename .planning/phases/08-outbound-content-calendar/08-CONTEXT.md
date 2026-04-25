# Phase 8 — Outbound Content + Calendar — CONTEXT

**Phase:** 08-outbound-content-calendar
**Planned:** 2026-04-24 (Kevin asleep — recommended defaults locked per orchestrator brief)
**Requirements:** AGT-07, AGT-08, CAP-09, MEM-05
**Depends on:** Phase 6 (loadContext + entity graph), Phase 4 (Approve-gate pattern + email-sender hook), Phase 5 (soft — channel stability), Phase 7 (morning brief consumer)
**Locked Decision #3 path:** direct `@anthropic-ai/bedrock-sdk` (`AnthropicBedrock`) in every agent Lambda; NO Claude Agent SDK `query()`.

---

## What This Phase Ships

1. **AGT-07 content-writer** — Sonnet 4.6 via AnthropicBedrock, drafts 5 platform variants (IG / LinkedIn / TikTok / Reddit / newsletter) from one Kevin topic using `BRAND_VOICE.md` + few-shot + `loadContext()`. Writes `content_drafts` rows; emits `draft.ready`. Structurally cannot publish (no `postiz:*` IAM).
2. **AGT-08 publisher** — Haiku 4.5 scheduling logic (no creative gen) + direct Postiz MCP calls via `/api/mcp/{API_KEY}` Streamable HTTP. Structurally cannot draft (no `bedrock:*` IAM). Reads `content_publish_authorizations` row before every Postiz call.
3. **CAP-09 Google Calendar read** — `services/calendar-reader` Lambda polls both accounts every 30 min via OAuth refresh tokens in Secrets Manager; writes `calendar_events_cache`; extends `@kos/context-loader::loadContext()` with optional `includeCalendar` flag for morning brief + per-entity context.
4. **MEM-05 document version tracker** — `services/document-diff` Lambda hooks the Phase 4 `email.sent` event; pulls attachments, SHA-256 hashes, looks up prior `document_versions` row by `(recipient_email, doc_name)`, if differs → Haiku-written `diff_summary`; surfaces in per-entity timeline.
5. **Imperative-verb mutation pathway (SC 6)** — new `services/mutation-proposer` + `services/mutation-executor` Lambdas. Two-stage classifier (regex → Haiku → Sonnet) on `capture.received` detects imperatives; resolves target via `@kos/resolver`; writes `pending_mutations` → Inbox card; on Approve, executor applies the change (Command Center archive, meeting reference archive — never deletes the raw capture row).
6. **Postiz Fargate deployment** — 0.5 vCPU × 1 GB ARM64 on existing `kos-cluster`, EFS for PostgreSQL data + media, MCP endpoint wired.

---

## Source Artifact Coverage Audit

| Source | Item | Coverage |
|--------|------|----------|
| GOAL | multi-channel content drafts via content-writer agent | Plan 08-02 |
| GOAL | Postiz publishes only on explicit Approve | Plans 08-00 (schema), 08-03 (route+publisher) |
| GOAL | document version tracking surfaces "what changed since v3 went to Damien" | Plan 08-05 |
| GOAL | Google Calendar reads inform per-entity context | Plan 08-01 |
| GOAL | imperative-verb mutation pathway recognises + proposes + executes on Approve | Plan 08-04 |
| REQ  | AGT-07 content-writer Sonnet 4.6 + BRAND_VOICE.md + few-shot + Inbox cards | Plan 08-02 |
| REQ  | AGT-08 publisher Haiku 4.5 + Postiz MCP + cancel-before-publish | Plan 08-03 |
| REQ  | CAP-09 Google Calendar both accounts + never books | Plan 08-01 |
| REQ  | MEM-05 SHA + diff against previous version per recipient | Plan 08-05 |
| ROADMAP SC 1 | 5-platform variants + Step Functions if >5 min | Plan 08-02 (Step Functions Standard) |
| ROADMAP SC 2 | Postiz MCP-wired + IAM split + cancel-before-publish | Plan 08-03 |
| ROADMAP SC 3 | Google Calendar read + morning brief + per-entity | Plan 08-01 |
| ROADMAP SC 4 | SHA + diff + diff_summary + surfaces in timeline | Plan 08-05 |
| ROADMAP SC 5 | Approve gate non-bypassable via IAM split + authorization row | Plans 08-00 (schema), 08-03 (route), 08-06 (gate verifier) |
| ROADMAP SC 6 | Imperative-verb mutation recognised + proposed + executes on Approve | Plan 08-04 |
| RESEARCH | Postiz MCP endpoint `/api/mcp/{API_KEY}` Streamable HTTP | Plan 08-03 |
| RESEARCH | Google Calendar API v3 events.list + timezone | Plan 08-01 |
| RESEARCH | Step Functions Standard (not Express) for 5-platform | Plan 08-02 |
| RESEARCH | pdfparse / mammoth / sha256 for attachments | Plan 08-05 |
| RESEARCH | Swedish imperatives (2nd-person) + English bare verbs | Plan 08-04 |

All 20 items covered. No gaps. No phase-split needed.

---

## Gray-Area Decisions — Recommended Defaults Locked

### D-01: BRAND_VOICE.md location and seed content

**Locked:** create `.planning/brand/BRAND_VOICE.md` (NOT `packages/brand/` — this is content/voice guidance, not runtime code). Seed with 3 tone bullets + 1 few-shot example per platform (IG / LinkedIn / TikTok / Reddit / newsletter) as placeholders. Mark `human_verification: true` at top; Kevin must fill in real voice before first real draft. Plan 08-00 creates the seed; Plan 08-02 reads it at runtime via `fs.readFileSync()` embedded in Lambda bundle (bundled as text asset — not re-read per invocation).

**Why placeholder (not Gemini-extracted):** dossier-loader / Vertex is provisioned in Phase 6 but running Gemini-extraction over Kevin's Tale Forge / Outbehaving public posts at planning time requires:
(a) live GCP access Kevin hasn't granted yet;
(b) structured ingestion of his public writing which is out-of-scope for this phase.
Kevin fills BRAND_VOICE.md after plan execution but BEFORE first real draft — enforced by Plan 08-02 Task 3 which refuses to draft if `human_verification: false` is still present (fail-closed).

### D-02: Step Functions vs parallel Lambda for 5-platform drafting

**Locked:** **Step Functions Standard** with a Map state over the 5 platforms. Reasons:
(a) Sonnet 4.6 + loadContext() + 500-token platform-specific prompt can exceed 2 min per platform on complex topics; 5 platforms serial = 10 min, breaks Lambda 15-min limit at p99.
(b) Standard (not Express) because each platform draft is ≥ 100ms (Express billed per 100ms) and we want per-platform retry semantics.
(c) Each platform drafter is its OWN Lambda (`content-writer-platform`) — a single workflow Lambda would be impossible to scale per-platform.

Cost: Step Functions Standard = $25 per million state transitions. At 5 states × ~10 drafts/week × 52 weeks = 2,600 transitions/year = ~$0.07/year. Trivial.

Plan 08-02 uses Step Functions Map with maxConcurrency=5 (all 5 platforms parallel). Input: `{ topic_id, topic_text, platforms: ['ig','linkedin','tiktok','reddit','newsletter'] }`. Output: `{ topic_id, drafts: [{ platform, draft_id, content }] }`.

### D-03: Postiz deployment shape

**Locked:** **self-hosted Fargate per locked decision** (CLAUDE.md stack spec). 0.5 vCPU × 1 GB ARM64, single task (Postiz is not horizontally scalable for single-user). EFS volume mounted at `/app/data` for PostgreSQL + media uploads (Postiz bundles its own PostgreSQL). MCP endpoint exposed at `http://<service-dns>:3000/api/mcp/{API_KEY}` via internal Cloud Map DNS.

NOT Postiz cloud: (a) 30 req/hr cloud limit breaks bulk Approve flows; (b) cookie-on-vendor violates privacy; (c) adds external dependency for a service already in the stack.

Postiz API key stored in Secrets Manager `kos/postiz-api-key`. Generated post-container-boot (operator runbook); Phase 8 execute phase has human_verification step for this.

### D-04: CAP-09 Google Calendar auth

**Locked:** **OAuth 2.0 per-account refresh tokens**, operator-supplied, stored in Secrets Manager as `kos/gcal-oauth-<account>` with shape `{ client_id, client_secret, refresh_token }`. Two secrets: `kos/gcal-oauth-kevin-elzarka` and `kos/gcal-oauth-kevin-taleforge`.

NOT service account with domain-wide delegation: (a) single-user Kevin is not on Workspace admin; (b) Tale Forge Workspace Kevin IS admin of but he personally doesn't need DWD; (c) operator flow parity with existing Gmail app passwords in Phase 4.

Refresh token obtained via one-time `scripts/bootstrap-gcal-oauth.mjs` operator flow (Plan 08-00 creates the script scaffold; full implementation deferred to execute-phase because it requires live OAuth consent screen).

### D-05: Imperative-verb coverage strategy

**Locked:** **two-stage classifier**:

1. **Regex pre-filter** (`services/mutation-proposer` handler entry) — fast-path Swedish + English imperatives:
   - Swedish: `^(ta bort|avboka|flytta|skjut(a)?|ändra|kolla upp|stryka?|radera|arkivera)\b` (2nd-person bare stem + inflected imperatives)
   - English: `^(cancel|delete|remove|drop|archive|reschedule|move|postpone|clear)\b`
2. **Haiku 4.5 classifier** — for captures that MATCH the regex, Haiku categorises: `{is_mutation: bool, mutation_type: "cancel_meeting" | "delete_task" | "archive_doc" | "reschedule_meeting" | "other", confidence: float}`.
3. **Sonnet 4.6 decision** — only if `is_mutation && confidence >= 0.7`, Sonnet receives full `loadContext()` + candidate targets (from `@kos/resolver` + CAP-09 meetings) and decides the `target_ref` + `proposed_action`.

Regex catches the easy cases (90%+). Haiku filters false positives (e.g., "ta bort lagret" = "take out the inventory" — not a mutation target KOS owns). Sonnet does the final target resolution.

If regex fails → proceed as normal voice-capture (no mutation check). If regex hits but Haiku says `is_mutation: false` → proceed as normal capture + log `agent_runs` row with `decision: false_positive`. If Haiku confidence < 0.7 → proceed as normal capture (conservative fail-open — mutations require high confidence to surface).

### D-06: Mutation target resolution tiebreaker

**Locked:** **explicit reference first, timestamp proximity fallback**:

1. Sonnet receives candidates from 3 sources in priority order:
   - `@kos/resolver` entity lookup on any named entities in the capture ("Damien call" → Damien entity → recent meetings with Damien)
   - `calendar_events_cache` filter by `start_time` in `[now, now + 24h]` matching any time/date mentioned ("mötet imorgon kl 11")
   - `command_center_index` recent tasks referenced by title fuzzy-match
2. If Sonnet picks 1+ candidate with confidence ≥ 0.8 → surface as single `pending_mutations` Inbox card with one Approve button.
3. If multiple candidates ≥ 0.6 OR no candidate ≥ 0.8 → surface `pending_mutations` Inbox card as **disambiguation** (multiple options shown; Kevin picks one before Approve). Kevin's pick becomes the `target_ref`.
4. If NO candidate ≥ 0.6 → no mutation card; log `agent_runs` row with `decision: no_target_match`; proceed as normal capture.

This prevents the 2026-04-23 failure mode (raw capture written as new Command Center task when the ask was "take off the calendar"). The dual-write to Command Center happens ONLY if regex pre-filter misses; if mutation path fires, the capture row is still written (for audit) but `voice-capture` sees the `mutation_pending` flag and skips Command Center insertion.

### D-07: Document version tracker storage key

**Locked:** **`(recipient_email, doc_name)`** as the composite key on `document_versions`. NOT `(recipient_email, entity_id)` because one recipient might get multiple distinct documents (Damien sees `avtal.pdf` and `cap-table.xlsx`).

Schema:
```sql
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  recipient_email text NOT NULL,
  doc_name text NOT NULL,           -- sanitised filename lowercased (e.g. 'avtal.pdf')
  sha256 text NOT NULL,
  s3_bucket text NOT NULL,
  s3_key text NOT NULL,              -- full blob path in kos-blobs eu-north-1
  version_n integer NOT NULL,        -- monotonically incremented per (recipient, doc_name)
  parent_sha256 text,                -- previous version (NULL for v1)
  diff_summary text,                 -- Haiku-written, NULL for v1
  sent_at timestamptz NOT NULL,
  capture_id text NOT NULL,          -- the email_drafts capture_id that triggered this
  CONSTRAINT document_versions_recipient_doc_sha_uidx UNIQUE (recipient_email, doc_name, sha256)
);
CREATE INDEX document_versions_recipient_doc_idx ON document_versions (recipient_email, doc_name, version_n DESC);
```

Lookup shape Kevin asks: `"what changed since v3 went to Damien"` → `SELECT diff_summary FROM document_versions WHERE recipient_email='damien@outbehaving.com' AND doc_name='avtal.pdf' AND version_n > 3 ORDER BY version_n`.

### D-08: Mutation vs content boundary

**Locked:** two TOTALLY separate event contracts; no flag-on-shared-event pattern.

- **Mutations** = state changes to EXISTING KOS records:
  - Command Center task archive (status → 'archived' + marker)
  - Meeting reference archive in `calendar_events_cache` (flag `ignored_by_kevin=true`, does NOT call Google Calendar write)
  - Draft archive (content_drafts.status → 'cancelled'; email_drafts.status → 'cancelled')
  - pending_mutations row state changes
  - Never deletes (archive-not-delete from Locked Decision #12)
  - Never writes Google Calendar or sends email or publishes Postiz (those are content paths)
- **Content** = NEW content into future publish/send paths:
  - content_drafts (content-writer)
  - email_drafts (email-triage from Phase 4)
  - No overlap; different DB tables; different EventBridge detail-types
  - Different Lambdas; different IAM roles

Event contracts:
- `pending_mutation.proposed` on `kos.agent` — from mutation-proposer
- `pending_mutation.approved` on `kos.output` — from dashboard-api Approve route
- `pending_mutation.executed` on `kos.output` — from mutation-executor
- `draft.ready` on `kos.output` — from content-writer
- `content.approved` on `kos.output` — from dashboard-api Approve route
- `content.published` on `kos.output` — from publisher

---

## Locked Decisions (D-XX Catalogue)

| ID | Decision |
|----|----------|
| D-01 | BRAND_VOICE.md at .planning/brand/ w/ placeholder + human_verification gate |
| D-02 | Step Functions Standard Map for 5-platform drafting |
| D-03 | Postiz self-hosted on Fargate 0.5 vCPU 1 GB + EFS |
| D-04 | Google Calendar via OAuth per-account refresh tokens in Secrets Manager |
| D-05 | Imperative mutation classification via regex → Haiku → Sonnet 3-stage |
| D-06 | Mutation target tiebreaker: explicit → timestamp → disambig card |
| D-07 | document_versions keyed by (recipient_email, doc_name); version_n monotonic |
| D-08 | Mutation vs content = separate tables + separate event contracts |
| D-09 | AnthropicBedrock direct SDK (no Agent SDK); per Locked Decision #3 revision |
| D-10 | IAM split: content-writer has NO postiz; publisher has NO bedrock; same for mutation roles |
| D-11 | @kos/context-loader extended with `includeCalendar?: boolean` (Plan 08-01) |
| D-12 | @kos/resolver reused — no new entity resolution stack for mutations |
| D-13 | Migration 0015 (Phase 6 0012, Phase 4 0012/0013, Phase 7 0014); bump if earlier lands |
| D-14 | Postiz cluster reuse: kos-cluster from Phase 1 KosCluster construct |
| D-15 | calendar-reader poll 30 min via EventBridge Scheduler (NOT push; Google Push doesn't suit our arch) |
| D-16 | document-diff hooks `email.sent` detail-type from Phase 4 kos.output bus |
| D-17 | mutation-executor never calls Google Calendar write; only archives local reference |
| D-18 | mutation-executor writes back to Notion via notion-indexer trust (status update) |
| D-19 | content-writer loads BRAND_VOICE.md as bundled text (esbuild loader: 'text') |
| D-20 | Step Functions state machine name: `kos-content-writer-5platform` |
| D-21 | Postiz API key stored in `kos/postiz-api-key`; rotated manually by operator |
| D-22 | Cancel-before-publish = soft delete on content_drafts + Postiz DELETE /api/posts/:id via MCP |
| D-23 | CAP-09 timezone handling: Europe/Stockholm at calendar-reader; store tz in calendar_events_cache |
| D-24 | Gracefully degrade on Phase 5 incomplete (cross-channel context mentions "not available yet") |
| D-25 | BRAND_VOICE.md `human_verification: false` = content-writer refuses to draft (fail-closed) |
| D-26 | Approve-gate: dashboard route writes `content_publish_authorizations` row BEFORE emitting `content.approved` |
| D-27 | mutation-proposer NEVER writes to Command Center; voice-capture sees mutation_pending flag and skips insertion |
| D-28 | Phase 8 uses `loadContext({ includeCalendar: true })` ONLY from content-writer + mutation-proposer |
| D-29 | document-diff p95 <10 sec per attachment (pdfparse on 50-page PDF ≤ 5 sec; SHA-256 <100ms) |
| D-30 | Step Functions state machine defined in `packages/cdk/lib/stacks/integrations-content.ts`; Lambda workers exist independently |
| D-31 | Postiz Fargate single task; session persistence on EFS; license NOT required (Postiz is AGPL self-host) |
| D-32 | calendar-reader idempotency key: `(account, event_id, updated_at)` composite |
| D-33 | content-writer refuses draft if loadContext returned zero entity matches AND no explicit topic specified |

---

## Deferred Ideas

- BRAND_VOICE.md seeding from Kevin's public Tale Forge + Outbehaving posts via Vertex Gemini (INF-10) — deferred; manual fill-in first pass
- Full iCal synchronisation (two-way write to Google Calendar) — out of scope (ROADMAP explicit: never books/accepts)
- Postiz analytics dashboard surfacing in KOS dashboard — out of scope per CLAUDE.md
- Automatic scheduling inference ("best time to post on LinkedIn is Tuesday 9am") — deferred; v1 publisher uses Kevin-specified schedule
- Multi-language BRAND_VOICE per Kevin's SV/EN code-switch — single BRAND_VOICE covers both; separate section for SV vs EN tone
- Mutation pathway to send emails on Kevin's behalf ("send Damien the avtal") — out of scope (still requires email-triage draft + Approve)
- pdf → Word round-trip diff (structural vs textual) — out of scope; v1 uses pdfparse text only
- OCR on image attachments — out of scope; document-diff skips non-text attachments with `diff_summary: 'binary — SHA only'`

---

## Phase 5 Incomplete Handling (D-24)

Phase 5 (Messaging Channels) is NOT planned in this overnight run. Phase 8 runs without it. Impact:

- `loadContext()` already handles missing WhatsApp/LinkedIn data (returns empty arrays for channels not yet populated)
- content-writer's per-platform prompt conditionally mentions: "WhatsApp/LinkedIn context for this entity: _not yet ingested (Phase 5 pending)_" when `loadContext` returns no WhatsApp/LinkedIn rows
- mutation-proposer target resolution does NOT try to resolve into WhatsApp/LinkedIn message threads (Phase 5 future enhancement)

No blocker. Phase 8 ships independently; Phase 5 later populates the same `mention_events` table and content-writer gains richer context automatically.

---

## Approve-Gate Invariants (SC 5)

Non-bypassable in code via structural IAM separation:

| Lambda | Has | Lacks |
|--------|-----|-------|
| content-writer | bedrock:InvokeModel (eu inference profile), secrets:GetSecretValue, rds-db:connect (write content_drafts) | postiz:*, ses:*, notion:* (mutation tier) |
| publisher | postiz:* (via MCP), secrets:GetSecretValue (postiz key), rds-db:connect (read content_publish_authorizations) | bedrock:*, ses:*, notion writes |
| mutation-proposer | bedrock:InvokeModel, secrets:GetSecretValue, rds-db:connect (read entity_index / write pending_mutations) | notion update perms, ses:*, postiz:*, google-calendar writes |
| mutation-executor | rds-db:connect (write pending_mutations.status), notion:update for specific row | bedrock:*, postiz:*, ses:*, google-calendar writes |
| calendar-reader | secrets:GetSecretValue (gcal OAuth), rds-db:connect (write calendar_events_cache) | google-calendar writes, bedrock:*, postiz:* |
| document-diff | bedrock:InvokeModel (Haiku for diff_summary), rds-db:connect (read/write document_versions), s3:GetObject (blobs) | ses:*, postiz:*, mutation writes |

CDK tests assert each Lambda's IAM policy does NOT contain forbidden actions (literal grep on synth output).

Data gate: content_publish_authorizations row is written ONLY by the dashboard Approve route; publisher's query joins `content_drafts INNER JOIN content_publish_authorizations ON draft_id` — no authorization row → no schedule call. Same shape as Phase 4 email_send_authorizations.

---

## Cost Estimate

| Item | Monthly Cost |
|------|-------------:|
| Postiz Fargate 0.5 vCPU 1 GB | ~$19 |
| EFS for Postiz persistence | ~$0.30 |
| content-writer Bedrock (Sonnet drafting ~10/wk × 5 = 50/mo × ~$0.05) | ~$2.50 |
| publisher Bedrock (Haiku scheduling ~50/mo × ~$0.001) | ~$0.05 |
| mutation-proposer Bedrock (Haiku filter ~200/mo × ~$0.001 + Sonnet decide ~50/mo × ~$0.05) | ~$2.70 |
| document-diff Bedrock (Haiku diff ~20/mo × ~$0.003) | ~$0.06 |
| calendar-reader Lambda (48 invocations/day × 30 days × ~50ms) | ~$0.01 |
| Google Calendar API v3 reads (~2,880/mo well under 1M/day free) | $0 |
| Step Functions Standard (~50 state transitions/mo × $0.000025) | $0.00 |
| **Total Phase 8 add** | **~$24.60/mo** |

Well inside the $200-400/mo all-in budget.

---

## Open Questions (carry into Phase 8 execution)

1. Postiz license self-host confirmed AGPL (Plan 08-03 verifies the operator runbook flags any version-specific license issues).
2. Google Calendar OAuth consent screen app verification — Kevin's personal project vs Tale Forge Workspace; may require verification for `calendar.readonly` scope. (Not a blocker; internal single-user use avoids verification screen.)
3. Step Functions IAM for Lambda-invoking-Lambda across AZ boundaries — Plan 08-02 Task 4 (CDK) explicit.
4. EFS throughput mode for Postiz — start on "bursting"; revisit if Postiz logs show I/O bottleneck under load.
5. pdf parsing library choice (`pdfparse` on Node 22.x) — confirmed in 08-RESEARCH.md; deferred to Plan 08-05 to decide `pdfparse` vs `pdf-parse` (package naming collision in npm).
6. Mutation executor's Notion API write scoping — currently no per-DB scoping in Phase 1 notion-indexer; Plan 08-04 may need to extend indexer with a `notion-mutation-applier` helper.

---

*Phase 8 context locked 2026-04-24 — all 33 D-XX decisions final.*
