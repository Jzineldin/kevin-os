# Phase 7: Lifecycle Automation — Research

**Gathered:** 2026-04-24
**Scope:** EventBridge Scheduler timezone semantics, Bedrock tool_use for briefs, Notion block-replace patterns, Stockholm DST, Telegram HTML parse_mode, compliance verification patterns.

---

## §1. EventBridge Scheduler — Europe/Stockholm timezone support

**Finding (HIGH confidence):** EventBridge Scheduler supports IANA timezone strings natively via `scheduleExpressionTimezone`. Stockholm maps to `Europe/Stockholm`. DST is handled automatically by the ICU library backing AWS — CET (UTC+1) Oct-Mar, CEST (UTC+2) Mar-Oct. Confirmed in official AWS docs: `https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-timezones.html`.

**Practical implication:** A schedule with `scheduleExpression: 'cron(0 8 ? * MON-FRI *)'` and `scheduleExpressionTimezone: 'Europe/Stockholm'` fires at:
- Mar 2026: 08:00 Stockholm CEST = 06:00 UTC
- Oct 2026 (after DST end): 08:00 Stockholm CET = 07:00 UTC
- **No manual DST math needed.** The schedule always fires at Kevin's wall-clock 08:00.

**Pattern in codebase:** `packages/cdk/lib/stacks/integrations-notion.ts` already uses this pattern for notion-indexer `rate(5 minutes)` + `Europe/Stockholm`. Phase 7 mirrors.

**Pitfall:** `flexibleTimeWindow: { mode: 'OFF' }` is MANDATORY for briefs. `mode: 'FLEXIBLE'` lets AWS delay fires up to 15 min — breaks the wall-clock contract Kevin expects.

---

## §2. EventBridge Scheduler cron syntax

**Finding (HIGH confidence):** AWS cron is 6-field: `minute hour day-of-month month day-of-week year`. The `?` wildcard means "no specific value" and is REQUIRED on one of day-of-month or day-of-week (they can't both be `*`).

**Valid Phase 7 expressions:**
- Morning brief (08:00 weekdays per D-18): `cron(0 8 ? * MON-FRI *)`
- Day close (18:00 weekdays): `cron(0 18 ? * MON-FRI *)`
- Weekly review (Sunday 19:00): `cron(0 19 ? * SUN *)`
- Email triage every 2h 08:00–18:00 weekdays: `cron(0 8/2 ? * MON-FRI *)` → fires at 08, 10, 12, 14, 16, 18
- Cap compliance (Sunday 03:00 Stockholm): `cron(0 3 ? * SUN *)`

**Invalid patterns to avoid:**
- `cron(0 7-19/2 ? * MON-FRI *)` — ranges with step work, but `8/2` is cleaner
- `cron(0 8 * * MON-FRI *)` — both day-of-month and day-of-week specified without `?` → rejected
- `rate(8 hours)` — anchored to schedule creation time, not wall-clock hour. NOT suitable for briefs.

**Rate vs cron:** Briefs NEED cron (specific time-of-day). Emails NEED cron (business hours alignment). Only polling (notion-indexer, granola-poller) uses `rate()`.

---

## §3. Bedrock tool_use for structured brief output

**Finding (HIGH confidence):** AnthropicBedrock SDK supports Claude's `tool_use` blocks natively. Forcing structured output via `tool_choice: { type: 'tool', name: '<tool_name>' }` guarantees Sonnet returns a single `tool_use` block with `input` matching the declared JSON schema.

**Pattern verified in codebase:** `services/entity-resolver/src/disambig.ts` uses this shape. Response parsing:
```typescript
const toolBlock = resp.content.find((b: any) => b.type === 'tool_use' && b.name === 'record_classification');
if (!toolBlock) return { output: <safe fallback>, ... };
const parsed = SchemaZod.safeParse((toolBlock as any).input);
```

**Phase 7 application:**
- Morning brief tool: `record_morning_brief` with MorningBriefSchema.
- Day close tool: `record_day_close_brief` with DayCloseBriefSchema.
- Weekly review tool: `record_weekly_review` with WeeklyReviewSchema.
- `tool_choice: { type: 'tool', name: '<...>' }` forces output shape.
- `max_tokens: 4000` covers the largest schema (weekly review with 10+ recap bullets).

**Confidence note:** Anthropic changed tool_use behaviour minorly between SDK versions. Current SDK version in `package.json` at Phase 4 ship was `@anthropic-ai/bedrock-sdk` 0.25.x — tool_use API stable since 0.20. Phase 7 doesn't need to bump the SDK.

---

## §4. Bedrock `cache_control: ephemeral` placement

**Finding (HIGH confidence):** Anthropic prompt caching via Bedrock works with `cache_control: { type: 'ephemeral' }` on individual content segments in the system array. Phase 2 triage proved it works on Bedrock.

**Phase 7 pattern (per D-13 system prompt layout):**
```typescript
system: [
  { type: 'text', text: MORNING_BRIEF_BASE_PROMPT, cache_control: { type: 'ephemeral' } },
  ...(kevinContextBlock.trim() ? [{ type: 'text', text: kevinContextBlock, cache_control: { type: 'ephemeral' } }] : []),
  ...(assembledMarkdown.trim() ? [{ type: 'text', text: assembledMarkdown, cache_control: { type: 'ephemeral' } }] : []),
]
```

**Cost savings:** Kevin Context segment gets cached across all 11 briefs per week → cache-read tokens cost 10% of standard. Assembled dossier varies per brief → miss-rate ~100% but the cost is already bounded by D-19's $1.32/mo estimate.

**Pitfall (Phase 2 wave-5 retro):** Empty `cache_control` text segments are FORBIDDEN by Bedrock. The conditional spread with `.trim()` check is mandatory — if kevinContextBlock is empty string, the segment is omitted entirely.

---

## §5. Notion block-replace-in-place for 🏠 Today page

**Finding (MEDIUM-HIGH confidence):** Notion API has NO atomic "replace all children" operation. The closest pattern is:
1. `GET /v1/blocks/{page_id}/children?page_size=100` → list existing children (may paginate; 🏠 Today rarely exceeds 100 blocks).
2. For each child: `PATCH /v1/blocks/{child_id}` with `{ "archived": true }` → archives block (Notion shows them in trash; auto-purged after 30 days).
3. `PATCH /v1/blocks/{page_id}/children` with `{ children: [...new blocks...] }` → appends fresh blocks.

**Rate limits:** Notion enforces 3 requests per second per integration (average — bursts to ~10 allowed). Phase 7's ~30 archives + 1 append = ~31 calls; sequential with 333ms spacing = ~10 seconds. Concurrent at 3 parallel = ~3-4 seconds. Phase 7 brief Lambdas have 10-minute timeouts — comfortable.

**Partial-failure tolerance:** If Lambda crashes after some archives but before append, 🏠 Today has fewer blocks but is not broken. Next day's brief-run archives any remaining + new content. Acceptable.

**Code shape to borrow:** `services/notion-indexer/src/notion.ts` has the Notion SDK setup pattern; Phase 7 brief-renderer writes a new helper.

---

## §6. Notion Daily Brief Log DB — append row

**Finding (HIGH confidence):** Notion's `POST /v1/pages` creates a page in a database. Properties must match the DB schema. Required for Phase 7:
- `Name` (title) = `"Morning Brief — 2026-04-25"` (format: `<Type> — <YYYY-MM-DD>` for sortability).
- `Date` (date property) = `{ start: "2026-04-25" }` (Stockholm calendar date).
- `Type` (select property) = `"morning" | "day-close" | "weekly-review"`.
- Page body blocks = rendered brief Markdown / Notion blocks (heading, paragraph, bulleted_list_item).

**DB schema assumption:** PROJECT.md §"Existing Stack" lists "Daily Brief Log" as an existing Notion DB in Kevin's workspace. Operator pre-seeds the DB ID in `scripts/.notion-db-ids.json` via the same mechanism as `kevinContext`/`commandCenter`. If the DB schema lacks `Type` / `Date` columns, operator adds them (one-time manual setup documented in 07-00 operator runbook).

**Azure Search indexer dependency:** Phase 6 Plan 06-03 built `services/azure-search-indexer-daily-brief` as a placeholder. Once Phase 7 ships and starts creating rows in Daily Brief Log, the indexer will populate Azure Search with brief documents → future semantic search over "what did Kevin prioritise 3 weeks ago".

---

## §7. Stockholm DST semantics

**Finding (HIGH confidence):** Sweden observes Central European Summer Time (CEST = UTC+2) from last Sunday of March 01:00 UTC to last Sunday of October 01:00 UTC. Otherwise Central European Time (CET = UTC+1).

**EventBridge Scheduler behaviour:** A schedule with `scheduleExpressionTimezone: 'Europe/Stockholm'` and cron `0 8 ? * MON-FRI *` fires at:
- 07:00 UTC during CET (e.g., February)
- 06:00 UTC during CEST (e.g., June)
- Kevin's wall-clock 08:00 in both cases.

**DST transition dates Phase 7 cares about:**
- 2026-03-29 01:00 UTC: CET→CEST (spring forward). A 02:00 local schedule would be SKIPPED that day. Phase 7's 03:00 cap-verify schedule is SAFE (03:00 exists both sides of the transition).
- 2026-10-25 01:00 UTC: CEST→CET (fall back). A 02:30 local schedule would fire TWICE that day. Phase 7's 03:00 cap-verify is SAFE.

**Lambda runtime clock:** AWS Lambda runs with `TZ=UTC` in the default container env (per KosLambda defaults). Any Stockholm-local math inside the Lambda MUST go through `toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })` — the pattern established in `services/push-telegram/src/quiet-hours.ts`. Phase 7 brief Lambdas need Stockholm dates for:
- `top3_membership.brief_date` (the Stockholm calendar date for the brief).
- `dropped_threads_v.detected_for_date` uses `(CURRENT_DATE AT TIME ZONE 'Europe/Stockholm')::date` in Postgres — no Lambda-side math needed for that query.

---

## §8. Telegram HTML parse_mode

**Finding (HIGH confidence):** Telegram Bot API `sendMessage` with `parse_mode: 'HTML'` supports a limited subset: `<b>`, `<i>`, `<u>`, `<s>`, `<a href="...">`, `<code>`, `<pre>`, `<pre><code class="language-...">`, `<tg-spoiler>`. Reference: `https://core.telegram.org/bots/api#html-style`.

**Hard limits:**
- Total `text` field ≤ 4096 chars (including HTML markup).
- Nested tags NOT allowed except `<a>` inside `<b>`/`<i>`.
- Must HTML-escape `<`, `>`, `&` in user-provided content (entity names, draft previews).

**Phase 7 template for Telegram push:**
```
<b>🌅 Morning brief — 2026-04-25</b>

{prose_summary}

<b>Top 3</b>
1. {title} · <i>{urgency}</i>
2. {title} · <i>{urgency}</i>
3. {title} · <i>{urgency}</i>

<b>Today</b> — 3 meetings, 2 deadlines
<b>Tomorrow</b> — 1 meeting

<b>Drafts ready</b> — 2 urgent (<a href="{DASH_URL}/inbox">Inbox</a>)

<b>Dropped threads</b>
• {title} (last touched {days}d ago)
• {title} (last touched {days}d ago)
```

**Truncation policy:** If total > 4096 chars, truncate in this priority order: (1) dropped_threads section, (2) calendar details, (3) prose_summary. Top 3 is never truncated (hard priority).

---

## §9. DynamoDB TelegramCap table read for verifier

**Finding (HIGH confidence):** Phase 1 SafetyStack creates `TelegramCap` with PK=`pk` (String, format `telegram-cap#YYYY-MM-DD`). TTL attribute `ttl` sweeps items 48h after creation.

**Verifier query (cap-compliance Lambda):**
```typescript
for (let d = 0; d < 14; d++) {
  const date = stockholmDateKeyNDaysAgo(d);
  const pk = `telegram-cap#${date}`;
  const r = await ddb.send(new GetItemCommand({ TableName, Key: { pk } }));
  const count = r.Item?.count?.N ? parseInt(r.Item.count.N) : 0;
  if (count > 3) violations.push({ date, count });
}
```

**TTL edge case:** The verifier runs Sunday 03:00 Stockholm → reads last 14 days. The oldest 12 days are LIKELY purged by TTL (48h sweep). **Workaround:** Emit a daily snapshot event to a new `cap_history` RDS table in the verifier Lambda itself, OR change DynamoDB TTL to 20 days, OR query `telegram_inbox_queue` + `agent_runs WHERE status='ok' AND agent_name='push-telegram'` for ground-truth.

**Chosen approach:** Query `agent_runs` — it has `started_at` + `agent_name` and never expires. For each of last 14 Stockholm-days, `SELECT count(*) FROM agent_runs WHERE agent_name='push-telegram' AND status='ok' AND started_at >= <day_start> AND started_at < <day_end>`. Robust, no TTL dependency. DynamoDB cap table query is a corroboration source where available.

---

## §10. CloudWatch compliance alarm pattern

**Finding (HIGH confidence):** The cleanest zero-touch pattern for "ongoing invariant compliance" is:
1. Scheduled Lambda runs the check (EventBridge Scheduler weekly).
2. Lambda emits SNS on violation via SafetyStack's existing `alarmTopic`.
3. Email subscription on the topic (already wired in Phase 1) delivers the alert.

**Alternative rejected:** CloudWatch Metric Alarm on a custom metric. Adds complexity (Lambda must put-metric-data; alarm config separate); Phase 7's daily count signal is better expressed as a Lambda-driven SQL query than a metric.

**Implementation:** Phase 7's `services/verify-notification-cap` Lambda on weekly cron; on violation calls `SNSClient.publish({ TopicArn: alarmTopic.topicArn, Subject: 'KOS cap violation', Message: ... })`. `kos.system / brief.compliance_violation` EventBridge event also emitted for dashboard surfacing (future enhancement).

---

## §11. Pitfalls

1. **Empty cache_control segments** (Phase 2 retro) — conditional spread required; Phase 7 mirrors.
2. **Notion rate limits** — 3 RPS per integration; morning-brief ~30 block churn must pace or parallelise with concurrency ≤ 3.
3. **Stockholm DST clock skew in Lambda** — Lambda's `TZ=UTC`; all Stockholm math via `toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })`. Inherit Phase 1's `quiet-hours.ts` pattern.
4. **Empty email batches should not fire a push** — Phase 4 email-triage's `scan_emails_now` handler already returns early on empty; Phase 7 doesn't need to re-enforce. Brief Lambdas emit a push unconditionally (calm-by-default: a daily rhythm is still valuable even on quiet days).
5. **Brief idempotency on Lambda retry** — EventBridge retries a failed Lambda up to 2 times; the `agent_runs` idempotency check on `capture_id` (the brief ULID generated at handler entry) MUST exist before any Bedrock call; duplicate capture_id → short-circuit.
6. **Notion 🏠 Today page — partial replace after crash** — accept; document; next-day run heals.
7. **Sonnet tool_use returning no tool_use block** (model garbage) — Zod safeParse with safe fallback (empty brief + `prose_summary="Brief generation fell back; see CloudWatch for <brief_ulid>"`) + `kos.system / brief.generation_failed` SNS.
8. **Top 3 entities not resolvable to dossier** — loadContext tolerates empty dossiers; brief still renders with reduced context.
9. **DynamoDB cap table TTL vs 14-day window** (§9) — query `agent_runs` instead.
10. **Concurrent brief fires** — unlikely but possible if a Lambda retry collides with the next schedule. `agent_runs` INSERT with `ON CONFLICT (capture_id) DO NOTHING` prevents double-writes; second run exits cleanly.
11. **Telegram message exceeds 4096** — truncation policy in §8; tested via unit test on pathological input.
12. **Migration number collision** (Phase 4 + Phase 6 + Phase 7 all reserving 0012–0014) — D-14 + 07-00 Task 3 next-available check.

---

## §12. External specs consulted

- AWS EventBridge Scheduler user guide — `https://docs.aws.amazon.com/scheduler/latest/UserGuide/` (HIGH, official).
- AWS EventBridge Scheduler timezone — `https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-timezones.html` (HIGH).
- AWS Lambda TZ environment — `https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html` (HIGH).
- Anthropic tool_use — `https://docs.anthropic.com/en/docs/build-with-claude/tool-use` (HIGH).
- Anthropic prompt caching — `https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html` (HIGH).
- Notion blocks API — `https://developers.notion.com/reference/patch-block-children` (HIGH).
- Notion rate limits — `https://developers.notion.com/reference/request-limits` (HIGH).
- Telegram Bot API HTML parse_mode — `https://core.telegram.org/bots/api#html-style` (HIGH).
- IANA timezone database — `https://www.iana.org/time-zones` for Europe/Stockholm semantics (HIGH).

---

*Phase 7 research gathered: 2026-04-24 — standard research level (Level 2, ~30 min). No DISCOVERY.md needed beyond this file — all libraries and services are existing stack elements.*
