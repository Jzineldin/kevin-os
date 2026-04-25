# Phase 8 — RESEARCH

**Researched:** 2026-04-24 (condensed for auto-mode planning)
**Scope:** Postiz MCP, Google Calendar API v3, Step Functions Standard for 5-platform drafting, pdf diff, Swedish/English imperative linguistics, Fargate cluster reuse, mutation race conditions.

---

## 1. Postiz MCP Endpoint

**Endpoint shape:** `http://<postiz-host>/api/mcp/{API_KEY}` via **Streamable HTTP** (MCP spec — the newer transport, NOT SSE which was deprecated in MCP v0.6+).

**Authentication:** API key in URL path segment. Rotate by regenerating in Postiz UI at `/settings/api-keys`.

**Key tool calls for publisher agent:**
- `create_post(platform, content, schedule_time?, media_urls?)` — schedules or publishes immediately if `schedule_time` omitted
- `list_posts(status?, limit?)` — status: 'scheduled' | 'published' | 'draft' | 'failed'
- `delete_post(post_id)` — cancels scheduled post; no-op if already published
- `get_post(post_id)` — status + platform response
- `list_integrations()` — returns connected platform auths; publisher asserts before calling create_post

**Wiring in AnthropicBedrock SDK:** Publisher is Haiku 4.5 with `tool_use` blocks. Rather than wire MCP at the Claude level (not supported by Bedrock direct SDK — MCP is Claude Desktop + Claude Agent SDK feature), we wrap Postiz MCP with a thin Node fetch helper in `services/publisher/src/postiz.ts`:

```typescript
export async function postizMcpCall(method: string, params: unknown): Promise<unknown> {
  const apiKey = await getSecret('kos/postiz-api-key');
  const r = await fetch(`${POSTIZ_BASE_URL}/api/mcp/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  if (!r.ok) throw new Error(`Postiz MCP ${r.status}: ${await r.text()}`);
  // Streamable HTTP returns a single JSON-RPC response or a stream; for tool calls, read once.
  return await r.json();
}
```

**Pitfall P-1:** Postiz stores OAuth tokens per-platform internally. First-time integration for each platform (IG, LinkedIn, TikTok, Reddit) requires human OAuth consent via Postiz UI. Plan 08-03 operator runbook captures this.

**Pitfall P-2:** Postiz MCP is NOT rate-limited at its own endpoint but upstream platforms (LinkedIn, Reddit) rate-limit. Publisher's `withTimeoutAndRetry` (imported from Phase 4 `services/_shared/`) absorbs 429s.

---

## 2. Google Calendar API v3

**Endpoints used:**
- `GET /calendars/primary/events?timeMin={ISO}&timeMax={ISO}&singleEvents=true&orderBy=startTime` — events.list with recurring expansion
- `GET /calendars/primary/events/{eventId}` — single event (for deltas; not used in v1, we refetch window)

**Auth:** OAuth 2.0 Bearer. Refresh token → access token exchange:
```
POST https://oauth2.googleapis.com/token
grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...
```
Access token valid ~1 hour. calendar-reader refreshes on cold start + when 401 received.

**Scope:** `https://www.googleapis.com/auth/calendar.readonly` ONLY. No `calendar.events` (write scope) granted. Plan 08-04 mutation-executor CANNOT call Calendar API — structural IAM isolation + no scope.

**Quota:** 1,000,000 queries/day per project (well above single-user scale). Each poll = 2 accounts × 1 events.list call = 48 × 2 = 96 calls/day. Trivial.

**Swedish timezone:** Store all events in UTC; convert to Europe/Stockholm at display time. Google Calendar API returns events with `start.dateTime` + `start.timeZone` (or `start.date` for all-day). calendar-reader stores both UTC and tz label in `calendar_events_cache`.

**Pitfall P-3:** `singleEvents=true` expands recurring events which can blow up calendar_events_cache for dense calendars. Mitigation: only fetch `[now, now + 48h]` window; prior-period events not cached (not needed for morning brief or mutation context).

**Pitfall P-4:** Events that span midnight Stockholm (timeMin/timeMax boundary) can be missed if window is exactly 24h. Mitigation: fetch [now - 1h, now + 48h] and dedupe by `(event_id, updated_at)`.

**OAuth consent screen:** Kevin as single user on his own Google Cloud project — consent screen "in testing" mode is fine; no verification needed for internal app.

---

## 3. Step Functions Standard vs Express (5-platform drafting)

**Standard:**
- Max execution: 1 year
- Billed per state transition: $25/million
- Exactly-once execution guarantees
- Full history retained (easier debugging)

**Express:**
- Max execution: 5 min
- Billed per 100ms + request
- At-least-once (not exactly-once) — state transitions can run twice on retry
- No history retained by default

**For 5-platform drafting:**
- Sonnet 4.6 per-platform draft: p50 ~30s, p99 ~90s
- 5 platforms in parallel Map (maxConcurrency=5): p99 ~90s total
- Under 5 min → Express would work
- BUT: exactly-once matters (we don't want two drafts for the same topic × platform because that creates duplicate content_drafts rows). Standard.

**Cost comparison at KOS scale:**
- Standard: 5 transitions per topic × ~10 topics/wk × 52 wk = 2,600 transitions/yr = $0.07/yr
- Express: 100ms × 5 parallel × 90s ≈ 450 billed-seconds × $0.00001/s × 10 topics/wk × 52 wk ≈ $2.34/yr

Standard wins on guarantees and is cheaper in total because transitions are rare.

**Map state pattern (ASL):**
```json
{
  "StartAt": "DraftAllPlatforms",
  "States": {
    "DraftAllPlatforms": {
      "Type": "Map",
      "ItemsPath": "$.platforms",
      "ItemSelector": { "topic_id.$": "$.topic_id", "topic_text.$": "$.topic_text", "platform.$": "$$.Map.Item.Value" },
      "MaxConcurrency": 5,
      "ItemProcessor": {
        "StartAt": "DraftPlatform",
        "States": {
          "DraftPlatform": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:eu-north-1:...:function:KosIntegrations-ContentWriterPlatform",
            "Retry": [{ "ErrorEquals": ["Lambda.ServiceException","Lambda.TooManyRequestsException"], "MaxAttempts": 2, "IntervalSeconds": 2 }],
            "End": true
          }
        }
      },
      "ResultPath": "$.drafts",
      "End": true
    }
  }
}
```

Entry point: `kos.agent / content.topic_submitted` EventBridge rule targets a tiny orchestrator Lambda that starts the state machine with `{ topic_id, topic_text, platforms: [...] }`.

---

## 4. Document Diff (MEM-05)

**Supported attachment types:** PDF, DOCX, TXT, Markdown.

**Libraries:**
- `pdf-parse` (Node 22.x compatible; uses pdf.js internally; returns `{ text: string, numpages: number, info: {...} }`)
- `mammoth` (.docx → text extraction)
- Plain text / markdown: `fs.readFileSync(path, 'utf8')`
- Other binary: skip with `diff_summary: 'binary — SHA-only'`

**SHA-256 stability:** File SHA is byte-stable, but PDF metadata (author, creation date, modification date) changes per save → different SHA even for visually identical content. Two approaches:

Approach A (byte SHA of raw file):
- Pros: simple, fast, deterministic
- Cons: "identical" PDF resave shows as new version

Approach B (text SHA after extraction):
- Pros: detects true content change
- Cons: slower, requires parsing

**Locked v1:** Approach B for PDF + DOCX + text. SHA-256 of extracted text stream. For binary non-parseable → Approach A (byte SHA).

Sample extraction + hash:
```typescript
import { createHash } from 'node:crypto';
import pdfParse from 'pdf-parse';

async function attachmentSha(buf: Buffer, mimeType: string): Promise<{ sha: string; text: string; type: 'text' | 'binary' }> {
  if (mimeType === 'application/pdf') {
    const parsed = await pdfParse(buf);
    const text = parsed.text.replace(/\s+/g, ' ').trim();
    return { sha: createHash('sha256').update(text, 'utf8').digest('hex'), text, type: 'text' };
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { default: mammoth } = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    const text = r.value.replace(/\s+/g, ' ').trim();
    return { sha: createHash('sha256').update(text, 'utf8').digest('hex'), text, type: 'text' };
  }
  if (mimeType.startsWith('text/') || mimeType === 'text/markdown') {
    const text = buf.toString('utf8').replace(/\s+/g, ' ').trim();
    return { sha: createHash('sha256').update(text, 'utf8').digest('hex'), text, type: 'text' };
  }
  return { sha: createHash('sha256').update(buf).digest('hex'), text: '', type: 'binary' };
}
```

**Haiku diff_summary prompt shape:**
```
You are comparing two versions of the same document sent to the same recipient.

<previous_version>
{prior.text truncated to 2000 chars}
</previous_version>

<current_version>
{current.text truncated to 2000 chars}
</current_version>

Return ONLY a one-paragraph diff summary in the author's original language (Swedish if original is Swedish).
Focus on MATERIAL changes (new clauses, changed numbers, changed parties). Ignore formatting-only changes.
If the changes are trivial (typo fixes, reordering) say so explicitly.
```

Sonnet NOT used: diff_summary is a mechanical summarisation task; Haiku handles in ~$0.003/call at p99 <5s.

**Pitfall P-5:** PDF text extraction whitespace is non-deterministic across pdf.js versions. `replace(/\s+/g, ' ').trim()` normalisation is essential for SHA stability across restarts.

**Pitfall P-6:** Large attachments (100+ pages) blow Haiku's 200k context. Truncate to 2000 chars per version → `diff_summary` reflects first-page changes. Future enhancement: per-page diff with map-reduce.

---

## 5. Imperative-Verb Linguistics

**Swedish imperatives:**
- Formed from verb stem in most cases: `ta bort` (take off), `avboka` (cancel), `flytta` (move), `stryk` (delete), `arkivera` (archive)
- Bare infinitive form often used colloquially (Kevin code-switches): `ta bort mötet`, not `tag bort mötet` (archaic)
- No 1st-person plural imperative in common speech ("let's cancel" = "vi avbokar" — declarative, handled differently)
- Politeness particles don't affect recognition: `kan du ta bort mötet` = `ta bort mötet` for KOS intent

**English imperatives:**
- Bare verb form: `cancel`, `delete`, `remove`, `drop`, `archive`, `reschedule`, `move`, `postpone`, `clear`
- "Please cancel" — `please` is noise; strip before matching
- Gerund form ("canceling the meeting") is descriptive NOT imperative — do not classify

**Regex pattern (Plan 08-04 uses this verbatim):**
```typescript
const SV_IMPERATIVES = /^(\s*(?:snälla|kan du|vill du)\s+)?(ta bort|avboka|flytta|skjut(?:a|t|it)?|ändra|stryka?|radera|arkivera|slut(?:a|ta|tat)?|skippa)\b/i;
const EN_IMPERATIVES = /^(\s*(?:please|can you|could you)\s+)?(cancel|delete|remove|drop|archive|reschedule|move|postpone|clear|skip)\b/i;
```

**False positive handling:**
- `"ta bort kaffet"` (take out the coffee — not a KOS resource) — regex matches, Haiku says `is_mutation: false`, no Sonnet call
- `"cancel the subscription"` (external billing, not KOS) — regex matches, Haiku flags as out-of-domain, Sonnet filters
- `"ta bort kaffet från mötet"` (remove coffee FROM the meeting) — ambiguous; Sonnet decides in context

**Decision threshold:** Sonnet only commits to a mutation if it can name a specific KOS record (Command Center task ID, calendar_events_cache event_id, or content_drafts/email_drafts draft_id). If no record matches the mention, conservatively skip.

---

## 6. Fargate Postiz Deployment

**Image:** `ghcr.io/gitroomhq/postiz-app:latest` (official). Single-container Dockerfile bundles Postiz web + API + internal PostgreSQL 16 + Valkey + nginx.

**Environment variables:**
- `DATABASE_URL=postgresql://postiz:postiz@localhost:5432/postiz` (internal PG on same container)
- `REDIS_URL=redis://localhost:6379` (internal Valkey)
- `JWT_SECRET=<generated>` (stored in Secrets Manager)
- `FRONTEND_URL=http://postiz.kos.local:3000`
- `BACKEND_INTERNAL_URL=http://localhost:3000`

**Platform:** ARM64 (matches Phase 1 `kos-cluster` cluster default). Postiz publishes ARM64 multi-arch images.

**Storage layout on EFS:**
- `/app/data/db` — PostgreSQL data directory
- `/app/data/uploads` — media uploads
- `/app/data/cache` — Valkey dump

**Task definition shape:**
```typescript
new FargateTaskDefinition(scope, 'PostizTask', {
  cpu: 512,
  memoryLimitMiB: 1024,
  runtimePlatform: {
    cpuArchitecture: CpuArchitecture.ARM64,
    operatingSystemFamily: OperatingSystemFamily.LINUX,
  },
  volumes: [{ name: 'postiz-data', efsVolumeConfiguration: { fileSystemId: efsFs.fileSystemId, transitEncryption: 'ENABLED' } }],
});
```

**Service definition:**
- `desiredCount: 1` (Postiz not scalable; hardcode to one)
- `minHealthyPercent: 0` (allow full replace on deploy — single-user tolerates brief downtime)
- `maxHealthyPercent: 100`
- `platformVersion: FargatePlatformVersion.VERSION1_4`
- Cloud Map DNS: `postiz.kos.local` in private namespace (reused from Phase 1)

**Cost:** 0.5 vCPU × $0.04048/hr × 730hr + 1 GB × $0.004445/hr × 730hr ≈ $18.70/mo Fargate + ~$0.30/mo EFS (minimal usage).

**Pitfall P-7:** Postiz single-task means brief downtime on deploy. For single-user, acceptable. For Kevin's v1 flow, publisher should retry on Postiz 503 with exponential backoff (already covered by withTimeoutAndRetry).

**Pitfall P-8:** EFS cold starts — first read after idle can be 1-3 sec. Mitigation: Postiz's own keepalive pings EFS on every request. Not a KOS concern.

**No license:** Postiz is AGPL-3.0 — self-hosting is free. No license procurement. (Different from EmailEngine which requires a $99/yr commercial license.)

---

## 7. Pitfalls Reference

| ID | Pitfall | Mitigation |
|----|---------|------------|
| P-1 | Postiz per-platform OAuth is manual | Operator runbook in Plan 08-03 |
| P-2 | Upstream platform rate limits | withTimeoutAndRetry absorbs |
| P-3 | Recurring event explosion | Fetch only 48h window |
| P-4 | Midnight boundary missed events | Fetch [-1h, +48h] + dedupe |
| P-5 | PDF whitespace non-determinism | Normalise before SHA |
| P-6 | Haiku 200k context blown on 100-page doc | Truncate to 2000 chars; future map-reduce |
| P-7 | Postiz single-task downtime on deploy | Acceptable for single-user; retry with backoff |
| P-8 | EFS cold start 1-3s | Postiz keepalive handles |
| P-9 | Mutation pathway races voice-capture writing Command Center | mutation-proposer writes pending_mutations BEFORE voice-capture handler runs; voice-capture checks for mutation_pending flag |
| P-10 | Google Calendar refresh token expires on 6-month inactivity | Daily EventBridge Scheduler poll keeps token active |
| P-11 | Step Functions Lambda's cold start adds 2-3s per platform | Provisioned Concurrency 1 per platform Lambda (optional; v1 skips; add if perf complains) |
| P-12 | Postiz DB in same container = non-durable on task replace | EFS mount preserves; test restart before production use |
| P-13 | Cross-AZ Lambda invocations cost $0.01/GB transfer | negligible at KOS volume |
| P-14 | document-diff fires on ALL sent emails including ones without attachments | handler short-circuits when `attachments.length === 0` |
| P-15 | BRAND_VOICE.md bundled in Lambda bundle grows bundle size | 2-5KB; negligible |

---

## 8. Architectural Responsibility Map

| Tier | Component | Phase 8 Role |
|------|-----------|--------------|
| Capture | `services/ios-webhook`, `services/ses-inbound`, etc. | NOT modified in Phase 8 |
| Triage | `services/triage` | NOT modified in Phase 8 |
| Agent | `services/content-writer` (AGT-07), `services/content-writer-platform` (per-platform worker), `services/publisher` (AGT-08), `services/mutation-proposer`, `services/mutation-executor`, `services/document-diff` | NEW in Phase 8 |
| Capture (calendar) | `services/calendar-reader` | NEW in Phase 8 — classified as capture because it writes calendar_events_cache as read-only data |
| Memory | `packages/context-loader` | EXTENDED in Phase 8 with `includeCalendar?: boolean` |
| Output | Postiz Fargate, `services/email-sender` (Phase 4) | NEW Postiz; email-sender reused via event hook |
| Dashboard | `services/dashboard-api` + `apps/dashboard/src/app/api/content-drafts/`, `apps/dashboard/src/app/api/pending-mutations/` | NEW routes in Phase 8 |
| Infra | CDK stacks | NEW `integrations-content.ts`, `integrations-calendar.ts`, `integrations-mutations.ts`, `integrations-postiz.ts` |

---

## 9. Security Domain (STRIDE pre-map)

Full STRIDE register in each Plan's `<threat_model>`. This section summarises the phase-level threats:

- **Spoofing**: Postiz API key leak → unauthorised scheduling. Mitigate via Secrets Manager + IAM scoping; rotate on compromise.
- **Tampering**: Attacker forges `pending_mutation.approved` event without authorization row. Mitigate via mutation-executor's loadAuthorization check + JOIN on authorization_id.
- **Repudiation**: Published post can't be traced to Approve. Mitigate via content_publish_authorizations.consumed_at + post_id stored back on content_drafts.
- **Information disclosure**: BRAND_VOICE.md in Lambda bundle leaks Kevin's voice if Lambda code stolen. Acceptable — Kevin's voice is his own public writing style; not a secret.
- **Denial of service**: content-writer state machine runaway (infinite Map). Mitigate via Step Functions execution timeout (10 min) + per-Lambda timeout (5 min).
- **Elevation of privilege**: mutation-executor gains Google Calendar write scope. Mitigate via OAuth scope `.readonly` ONLY; mutation-executor has no `googleapis.com` egress whatsoever.

---

## 10. Sources

- Postiz docs (https://docs.postiz.com/) — MCP endpoint shape, AGPL license, Docker deployment
- Google Calendar API v3 docs — events.list parameters, OAuth scopes, quota
- AWS Step Functions Developer Guide — Standard vs Express, Map state
- pdf-parse npm — Node 22 compatibility, API surface
- mammoth npm — .docx extraction
- Phase 4 `services/email-sender/src/ses.ts` — SES send pattern for MEM-05 hook target
- Phase 6 `packages/context-loader/src/loadContext.ts` — extension point for `includeCalendar`
- Phase 1 `packages/cdk/lib/constructs/kos-cluster.ts` — Postiz deployment target
- Phase 2 `services/voice-capture/src/agent.ts` — AnthropicBedrock direct SDK pattern (mirrored in all Phase 8 agents)
- Phase 4 `services/email-triage/src/agent.ts` — Haiku classify + Sonnet draft pattern (mirrored in mutation-proposer)
- Phase 4 `services/email-sender` — Approve-gate + IAM split pattern (mirrored in publisher + mutation-executor)

---

*Research consolidated: 2026-04-24.*
