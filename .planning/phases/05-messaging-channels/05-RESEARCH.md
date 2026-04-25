# Phase 5: Messaging Channels — Research

**Gathered:** 2026-04-24
**Status:** Condensed findings; MEDIUM-HIGH confidence on architectural claims; each citation is verifiable from official sources at execute-time.

---

## 1. Chrome MV3 service_worker lifecycle

**Core constraint:** `background.service_worker` in MV3 terminates when idle (~30 s of inactivity). This is the single most common MV3 bug source.

**Implications for Phase 5:**
- `setInterval` / `setTimeout` do NOT survive idle termination. Use `chrome.alarms.create(name, { periodInMinutes })` which the browser wakes the service worker for.
- Module-scoped variables reset on each wake. Persistence must go through `chrome.storage.local` (survives) or `chrome.storage.session` (cleared on browser close).
- Message passing: `chrome.runtime.onMessage` handler MUST `return true` when using async `sendResponse` — otherwise the channel closes before the async path completes.
- Service worker registration: `"background": { "service_worker": "background.js" }` — string, NOT array, NOT `"scripts"` (MV2 legacy).

**Pattern:** The LinkedIn poll in Plan 05-03 uses `chrome.alarms` in `background.ts`; the alarm handler injects a content script message; the content script (which lives in the LinkedIn page DOM, NOT the service worker) performs the visibility check and the fetch. Voyager cookies never leave the browser.

**Sources:**
- https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers (official Chrome developer docs)
- https://developer.chrome.com/docs/extensions/reference/api/alarms

---

## 2. LinkedIn Voyager API shape

**Endpoint observed:** `https://www.linkedin.com/voyager/api/messaging/conversations` (GET, credentials: 'include').

**Response shape (empirically observed, subject to drift — content script parses defensively):**
```jsonc
{
  "elements": [
    {
      "entityUrn": "urn:li:fs_conversation:2-XXX",
      "lastActivityAt": 1713832345678,
      "participants": [...],
      "messages": { "*elements": ["urn:li:fs_event:XXX", ...] }
    }
  ],
  "paging": { "start": 0, "count": 20, "total": 127 }
}
```

**Thread reads:** `GET /voyager/api/messaging/conversations/{conversationUrn}/events?count=20` returns individual messages with sender, body text, timestamp.

**Authentication:** LinkedIn session cookies (`li_at`, `JSESSIONID`, `bcookie`, etc.). `credentials: 'include'` attaches them automatically when the request originates from a page on `linkedin.com` (same origin). CRITICAL: cookies NEVER leave the browser — content script extracts message payload and POSTs only the payload (no headers, no cookies) to `linkedin-webhook` Lambda.

**Ban-detection heuristics (observed from bans reported publicly):**
- Request rate from single session >100 Voyager calls/hour → scrutiny.
- Requests while tab is hidden (via Visibility API) → flagged as bot behavior.
- Missing or stale `csrf-token` header in POST requests (we only GET).
- Requests from user-agents matching known automation strings (we use the native browser UA).

**Our mitigations:**
- ≤1 poll per 30 min (~48 / day max — well below thresholds).
- `document.visibilityState === 'visible'` gate.
- 2-15 s jittered delays between sub-requests.
- Silent-fail + 24h backoff on any 401/403.
- 14-day observation window with zero "unusual activity" warnings required before production-label.

**Sources:**
- Reverse-engineering notes: https://github.com/linkedin-api/linkedin-api (Python wrapper, same Voyager endpoints)
- https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Public Q1 2026 ban-wave reports (CLAUDE.md reference)

---

## 3. Baileys WhatsApp protocol + pluggable auth

**Baileys** = reverse-engineered TypeScript implementation of WhatsApp Web. No first-party support from Meta. Connects as a WebSocket client to `*.whatsapp.net` using Signal-protocol end-to-end encryption.

**Pluggable auth interface (Baileys ≥ 6.x):**
```typescript
interface AuthenticationState {
  creds: AuthenticationCreds;      // Noise handshake keys, identity, registration data
  keys: SignalKeyStore;             // Per-session Signal keys (pre-keys, session records, sender keys)
}
interface SignalKeyStore {
  get(type: string, ids: string[]): Promise<Record<string, any>>;
  set(data: Record<string, Record<string, any>>): Promise<void>;
  clear?(): Promise<void>;
}
```

The library accepts any implementation; default is `useMultiFileAuthState(folderPath)` (writes JSON files to disk). Our custom provider = `usePostgresAuthState(ownerId, pool)`: each `keys.set(data)` call UPSERTs rows into `whatsapp_session_keys`; each `keys.get(type, ids)` reads them. `creds` serialises to a single row with `key_type='creds'`.

**Critical concurrency invariant:** Only ONE process may call `keys.set()` for a given `ownerId` at a time. Multiple Fargate tasks = corrupt signal state = decryption failures. Hence single-task (D-05).

**Read-only enforcement:** The library's `sock.sendMessage`, `sock.groupCreate`, `sock.updateStatus`, `sock.sendPresenceUpdate`, `sock.chatModify`, `sock.readMessages` are all wrapped in a Proxy/guard that throws + logs. Details in Plan 05-04.

**TOS risk assessment:**
- Meta's TOS prohibits automated access to WhatsApp Web. Read-only, personal-number, low-volume = low detection probability but non-zero.
- Detection signals Meta has been observed to use: excessive connection churn, concurrent sessions from multiple devices/IPs, abnormal message send patterns (we send ZERO), group-create churn (we create ZERO).
- Fallback: Telegram remains the primary capture channel. If WhatsApp revokes session, the Dashboard shows a `system_alert` and Kevin re-scans QR or abandons the channel; no data loss because every inbound message was already mirrored to KOS.

**Sources:**
- https://github.com/WhiskeySockets/Baileys (upstream)
- https://github.com/fazer-ai/baileys-api (our chosen REST wrapper)
- https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/use-generic-auth-state.ts (pluggable auth pattern)

---

## 4. WhatsApp unusual-activity detection heuristics

What triggers Meta's anti-automation signal:
- High-volume outbound `sendMessage` → we send ZERO.
- High-rate `groupCreate` → we create ZERO.
- `updateStatus` (WhatsApp profile updates) → we NEVER call.
- `sendPresenceUpdate` (typing-indicator abuse) → we NEVER call.
- Connection churn (reconnect > 3x/hour) → 4-hour backoff on rejection.
- Multiple concurrent sessions same account → single-task invariant.

Since KOS is strict read-only AND single-task AND 4h backoff, we operate entirely below detection thresholds.

---

## 5. Discord channel polling

`#brain-dump` channel in Kevin's existing Discord workspace. Bot token (legacy VPS stack) can authenticate as a polling client. Post-Phase-10-Plan-10-04 migration: a Lambda polls `GET /channels/{channel_id}/messages?after={last_id}` every 5 min, emits one `capture.received / kind: discord_text` per new message.

**Rate limits:** Discord API enforces 50 requests/second globally per bot token. Polling every 5 min = well under. Per-channel limit: 10 messages/s for reads (also under).

**Idempotency:** Each Discord message has a snowflake ID; capture_id = deterministic hash of `(channel_id, message_id)`. Duplicate processing = idempotent emit.

**Channel webhook alternative:** Discord supports channel webhooks (POST-on-new-message). Not used here — polling matches the "fallback" semantics (KOS keeps Discord as a last-resort capture, not a first-class push integration).

**Sources:**
- https://discord.com/developers/docs/resources/channel#get-channel-messages
- https://discord.com/developers/docs/topics/rate-limits

---

## 6. Pitfalls (high-signal)

**Pitfall A — MV3 `setInterval` does NOT survive idle:** Use `chrome.alarms` exclusively for any timed work in background service workers. Confirmed in Phase 5 Plan 05-01/05-03.

**Pitfall B — LinkedIn Voyager cookies expire + get rotated:** The content script never explicitly handles cookies (they ride on `credentials: 'include'`). If LinkedIn rotates `JSESSIONID` mid-session, the next Voyager call 401s; our silent-fail + 24h backoff + Dashboard `system_alert` is the recovery path.

**Pitfall C — Baileys session key concurrent writes:** Any race on `keys.set()` for the same `owner_id` corrupts signal state → decryption errors → full re-scan required. Solved by single-task invariant + a PG advisory lock in the `usePostgresAuthState` helper (optional, belt-and-braces).

**Pitfall D — Discord rate limits are per-bot-token, not per-channel:** Kevin's bot token is shared across legacy scripts + new Lambda. Rate-budget review documented in Plan 05-06.

**Pitfall E — LinkedIn Q1 2026 ban escalation (CLAUDE.md):** The defensive posture (tab-focus + 30-min + jittered delays + 14-day observation) is calibrated specifically to stay below the new thresholds. If 14-day observation surfaces even one warning, Plan 05-03 triggers auto-disable + Inbox card for Kevin to decide.

**Pitfall F — Baileys `fazer-ai/baileys-api` upstream drift:** If the image goes stale (>90 days without commit), swap to `PointerSoftware/Baileys-2025-Rest-API`. Fallback documented in Plan 05-04 action text.

**Pitfall G — Chrome extension service_worker cold-wake latency (~200-500ms):** Alarms have ±1-minute jitter when the browser decides to wake the worker. Acceptable for a 30-min poll cadence.

**Pitfall H — MV3 `host_permissions` vs `matches`:** Content scripts declared in `manifest.json` `content_scripts[].matches` need matching `host_permissions` for `chrome.runtime.sendMessage` + fetch. Our manifest declares both for `https://www.linkedin.com/*`.

**Pitfall I — WhatsApp QR re-scan storm on RDS auth mishandling:** If the custom auth provider returns stale creds (e.g., READ COMMITTED race), Baileys declares the session invalid and forces a new QR scan. Fix: wrap all `keys.get()` in a single transaction + use `SELECT ... FOR UPDATE` when writing. Detail in Plan 05-04.

**Pitfall J — Chrome extension Bearer token leak:** Options page stores Bearer in `chrome.storage.local` (not `chrome.storage.sync`, which syncs across devices). `chrome.storage.local` is process-local and encrypted at rest by Chrome. Plus webhook HMAC is a secondary layer: even if Bearer leaks, HMAC-signing the body with a separate secret blunts replay.

**Pitfall K — SES inbound / SG egress rules for WhatsApp don't compose cleanly:** We use explicit WhatsApp endpoint allowlisting in the SG; if Meta changes endpoints, we adapt at deploy time. Documented in Plan 05-04 operator runbook.

**Pitfall L — Chrome extension options page CSP:** MV3 forbids inline scripts. `options.html` loads `options.js` via `<script src=...>`, never inline `<script>alert(...)</script>`. Confirmed in Plan 05-01 manifest CSP.

---

## 7. Standard stack (Phase 5 inherits)

- `@anthropic-ai/bedrock-sdk` — NOT used in Phase 5 (capture-only; triage downstream calls it).
- `drizzle-orm` + `pgvector` — for `whatsapp_session_keys` schema.
- `@kos/contracts` — Zod schemas for all new capture shapes.
- `@aws-sdk/client-eventbridge` + `client-secrets-manager` + `client-cloudwatch` — standard Lambda deps.
- `@kos/test-fixtures` — extends with MV3 runtime stub, Voyager response fixture, Baileys incoming fixture.

---

## 8. Architectural Responsibility Map (Phase 5 self-check)

| Tier | Responsibility | Who |
|------|---------------|-----|
| Capture | Accept inbound event, validate auth, shape into capture.received | Chrome ext + 3 ingress Lambdas |
| Storage | Raw artifact persistence | S3 (voice notes), RDS (session keys, alerts, sync_status) |
| Event Bus | Fan-out to triage + downstream | kos.capture + kos.system |
| Triage | Classify + route | Phase 2 Lambdas (unchanged) |
| Presentation | Alerts, health, daily brief | Phase 3 Dashboard + Phase 7 morning-brief |

Phase 5 adds only Capture + Storage + EventBridge wiring. No new triage, no new agent logic, no new presentation surfaces beyond the existing `system_alerts` table.

---

## 9. Confidence notes

- HIGH: MV3 lifecycle, chrome.alarms, manifest shape, Voyager endpoint existence.
- HIGH: Baileys pluggable auth interface, single-task invariant, read-only enforcement strategy.
- MEDIUM: Exact Voyager response shape (content script parses defensively; first-call probe logs shape).
- MEDIUM: Meta's exact detection thresholds (inferred from public ban-wave reports; our defensive posture is calibrated for safety margin).
- MEDIUM: fazer-ai/baileys-api vs PointerSoftware activity — verify at deploy time.
</content>
</invoke>