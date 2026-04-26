# Plan 05-02 — Agent Notes

**Branch:** `worktree-agent-a9465425faac6251f` (off `phase-02-wave-5-gaps`,
which already contained Phase 4. The Phase 5 Plan 05-00 scaffold from branch
`phase-05-plan-00-scaffold` was merged in to land the LinkedIn / Chrome
extension / WhatsApp scaffolding before this plan started.)

## Scope clarification

The user-supplied task narrative described the LinkedIn DM scraper +
linkedin-webhook Lambda (CAP-05). The file path `05-02-PLAN.md` in the
repository actually describes the **Chrome highlight** webhook (CAP-04); the
LinkedIn work is documented in `05-03-PLAN.md`.

Per the user's auto-mode instruction to "make reasonable assumptions and
proceed," I implemented what the user described in the goal section
(LinkedIn DM scraper + linkedin-webhook), since the artefact list they
named (`services/linkedin-webhook/`, `apps/chrome-extension/src/content-linkedin.ts`,
`packages/cdk/lib/stacks/integrations-linkedin-webhook.ts`,
`packages/test-fixtures/src/phase-5/voyager-response.ts`,
`CaptureReceivedLinkedInDmSchema`) all match Plan 05-03's surface exactly.

This note flags the mismatch so the next-up reviewer can rename the
artefact (rebrand 05-02 → 05-03) or re-route this work under the right plan
number without re-implementing.

## Files added / modified

### Chrome extension (LinkedIn DM scraper)

- `apps/chrome-extension/src/content-linkedin.ts` — main content script.
  Two complementary capture strategies:
  1. **Voyager fetch interceptor (primary)** — patches `window.fetch` so
     LinkedIn's own calls to `/voyager/api/messaging/conversations…` and
     `…/events` are observed without a synthetic poll. Cookies stay in the
     browser; only parsed message bodies leave.
  2. **DOM mutation observer (fallback)** — watches the messaging pane for
     newly-rendered `[data-event-urn]` nodes and scrapes the visible text.
     Fires when LinkedIn switches to a non-Voyager (e.g. WebSocket) delivery
     path.
  Exports `ingestVoyagerResponse`, `installFetchInterceptor`,
  `installDomObserver`, `extractConversationUrn`, `__resetForTests`.

- `apps/chrome-extension/src/_lib/hmac.ts` — browser-side HMAC-SHA256 signer
  using `crypto.subtle`. Same wire format as the iOS-webhook Node-side
  signer (`t=<unix>,v1=<hex>`).

- `apps/chrome-extension/src/_lib/storage.ts` — `chrome.storage.local`
  config helpers (`webhookUrl`, `bearer`, `hmacSecret`).

- `apps/chrome-extension/src/_lib/ulid.ts` — Crockford-base32 ULID-shape
  generator. Both `randomUlid()` and `deterministicUlidFromString(seed)` —
  the deterministic flavour maps `sha256(message_urn)` to a 26-char ULID
  shape so the `capture_id` is stable across re-observations (matches
  `ses-inbound`'s pattern).

- `apps/chrome-extension/test/linkedin.test.ts` — 12 unit tests covering
  Voyager-response ingestion, in-memory dedupe, cross-session dedupe,
  schema validity, fetch-interceptor idempotency, and the DOM-observer
  fallback path.

- `apps/chrome-extension/vitest.config.ts` — switched `environment` to
  `jsdom` (required by MutationObserver + crypto.subtle tests).

- `apps/chrome-extension/package.json` — added `jsdom@25.0.1` dev dep.

The user explicitly forbade touching `apps/chrome-extension/src/background.ts`
or `content-highlight.ts` (Plan 05-01 owns them); I respected that. The
shared utilities live under `_lib/` to avoid a merge conflict with whatever
shape Plan 05-01 lands at `lib/`.

### Lambda (services/linkedin-webhook)

- `services/linkedin-webhook/src/handler.ts` — Function URL handler:
  Bearer (constant-time) → HMAC-SHA256 with ±300 s drift window →
  `JSON.parse` → `CaptureReceivedLinkedInDmSchema.safeParse` (overwriting
  `received_at` with the Lambda's clock) → `PutEvents` to `kos.capture`.

- `services/linkedin-webhook/src/secrets.ts` — Secrets Manager loader for
  `BEARER_SECRET_ARN` + `HMAC_SECRET_ARN`. Fail-closed on missing or
  literal `'PLACEHOLDER'` value.

- `services/linkedin-webhook/src/hmac.ts` — Node-side verifier mirroring
  the algorithm in `services/ios-webhook/src/hmac.ts`.

- `services/linkedin-webhook/test/handler.test.ts` — 14 unit tests covering
  happy path, missing/wrong Bearer (401), missing X-KOS-Signature (400),
  drift > 300 s (401), tampered v1 (401), invalid JSON (400), schema
  failures (missing `message_urn` and non-ULID `capture_id` both 400),
  non-POST (405), wrong path (404), empty body (400), `received_at` overwrite,
  trace-tagging, and the precise PutEvents call shape (Bus +
  Source + DetailType).

- `services/linkedin-webhook/package.json` — added the OTel +
  Langfuse + Sentry deps the `_shared/tracing.ts` module requires (mirror
  of ios-webhook's deps).

- `services/linkedin-webhook/tsconfig.json` — added the `@opentelemetry/*`,
  `@langfuse/*`, `@arizeai/*` `paths` entries and the `../_shared/**/*.ts`
  include (mirror of ios-webhook's tsconfig).

### CDK

- `packages/cdk/lib/stacks/integrations-linkedin-webhook.ts` —
  `wireLinkedInWebhook(scope, props)` helper:
    - 2 Secrets Manager entries (`kos/linkedin-webhook-bearer`,
      `kos/linkedin-webhook-hmac`) with `RemovalPolicy.RETAIN`.
    - `KosLambda` with 256 MB / 10 s timeout / arm64 / Node.js 22.x.
    - Function URL `authType=NONE` + `InvokeMode=BUFFERED`.
    - IAM grants: `secretsmanager:GetSecretValue` on BOTH secrets;
      `events:PutEvents` on `kos.capture`. NO bedrock / SES / DynamoDB /
      S3 / RDS — defence-in-depth verified by the synth test.
    - `CfnOutput` `LinkedInWebhookUrl` (export `KosLinkedInWebhookUrl`).

- `packages/cdk/lib/stacks/integrations-stack.ts` — added optional
  `enableLinkedInWebhook?: boolean` prop and corresponding wiring block.
  Synth-gated so existing test fixtures stay green; production deploy
  flips the flag.

- `packages/cdk/test/integrations-linkedin-webhook.test.ts` — 9 synth
  assertions: Lambda shape, env vars, Function URL config, both Secrets,
  IAM positives + negatives, CfnOutput presence, and a control test that
  proves nothing synthesises when `enableLinkedInWebhook` is omitted.

## Test count

| Suite | Tests | Status |
|-------|-------|--------|
| `@kos/chrome-extension` (linkedin.test.ts) | 12 | Pass |
| `@kos/service-linkedin-webhook` (handler.test.ts) | 14 | Pass |
| `@kos/cdk` (integrations-linkedin-webhook.test.ts) | 9 | Pass |
| **Total new** | **35** | **All pass** |

Sanity checks also performed:
- `pnpm --filter @kos/chrome-extension typecheck` — clean
- `pnpm --filter @kos/service-linkedin-webhook typecheck` — clean
- `pnpm --filter @kos/cdk typecheck` — clean
- `pnpm --filter @kos/chrome-extension build` — clean (`dist/content-linkedin.js`
  produced; ~16 KB minified + source map)
- `pnpm --filter @kos/contracts test` — 36/36 pass (including
  `phase-5-captures.test.ts` which validates the LinkedIn schema shape).
- `pnpm --filter @kos/cdk test -- --run integrations-ios-webhook` — 11/11
  still pass (no regression from integrations-stack edit).

Full `pnpm --filter @kos/cdk test` was not run end-to-end (the suite takes
~10 minutes for ~40 stacks); the surfaces that touch the IntegrationsStack
edit (ios-webhook + linkedin-webhook + app.test) all pass.

## Operator runbook (post-deploy)

1. Set `enableLinkedInWebhook: true` in the production CDK app's
   `IntegrationsStack` props (or wherever the app composes stacks).
2. `cdk deploy KosIntegrations`.
3. Read the Function URL from the CFN output:
   ```bash
   aws cloudformation describe-stacks --stack-name KosIntegrations \
     --query "Stacks[0].Outputs[?OutputKey=='LinkedInWebhookUrl'].OutputValue" \
     --output text
   ```
4. Seed both secrets:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id kos/linkedin-webhook-bearer \
     --secret-string "$(openssl rand -hex 24)"
   aws secretsmanager put-secret-value \
     --secret-id kos/linkedin-webhook-hmac \
     --secret-string "$(openssl rand -hex 32)"
   ```
5. Open the extension Options page, paste:
    - Webhook URL (without `/linkedin` suffix — handler appends it itself)
    - Bearer (the seeded value above)
    - HMAC secret (the seeded value above)
6. Visit any `linkedin.com/messaging/...` thread; observe a Lambda
   invocation in CloudWatch and a `capture.received` event on
   `kos.capture` with `kind: linkedin_dm`.

## Idempotency / dedupe story

- `capture_id` is `sha256(message_urn)` mapped to a 26-char Crockford
  base32 string. Re-observing the same Voyager event produces the same
  capture_id, so the Phase 2 triage dedupe (already keyed on capture_id)
  catches duplicates server-side.
- The content script ALSO dedupes client-side via two layers:
   1. In-memory `Set<string>` of seen URNs — survives the content-script
      lifetime.
   2. `chrome.storage.local.linkedin_seen_urns` — survives tab reload /
      single-page-app navigation. Capped at the most recent 2000 URNs
      to bound storage growth.

## Threat model coverage (Plan 05-03 STRIDE register)

- **T-05-03-01 spoofing (LinkedIn page → extension)**: content scripts run
  in an isolated world; LinkedIn JS cannot read `chrome.storage.local`.
- **T-05-03-02 info disclosure (Voyager cookies leak server-side)**:
  `fetch(..., credentials:'include')` keeps cookies inside the browser;
  the extension forwards only parsed JSON bodies + URNs to the webhook.
  HMAC + Bearer auth covers the wire from extension → Function URL.
- **T-05-03-03 unusual-activity detection**: NOT FULLY MITIGATED in this
  plan. The Voyager interceptor is purely passive (no synthetic GET
  requests), which already eliminates the synthetic-poll vector that
  Plan 05-03's risk register flagged. The 30-min visibility-gated alarm,
  2–15 s jitter, and 14-day observation window described in 05-03 are
  out-of-scope for this plan; they belong with the synthetic-poll
  fallback if/when LinkedIn closes off the fetch-interceptor approach.
- **T-05-02-06 timing attack on Bearer**: `crypto.timingSafeEqual` after
  length-pre-check (mirrors `services/ios-webhook/src/hmac.ts`).

## Known gaps / follow-ups

1. **Synthetic-poll fallback**. The user task didn't ask for the
   30-min `chrome.alarms` poller from Plan 05-03 §Task 1. The fetch
   interceptor + DOM observer combination should cover Kevin's primary
   use case (he reads DMs in the browser, so the Voyager fetch fires
   organically). If a Future Kevin scenario needs polling when the tab
   is open but idle, that comes in a follow-up plan.

2. **`/linkedin/alert` route** for `system_alerts` insertion. Plan 05-03
   §Task 2 calls for it; not implemented here because (a) the user
   task spec only mentioned `capture.received` emission, and (b) it
   requires RDS Proxy wiring + a new IAM grant that the test fixtures
   don't yet exercise. Easy to add when the alert-emit path is needed.

3. **Manifest `tabs` permission + alarm registration in
   `background.ts`** — needed only by the synthetic poller in Plan 05-03;
   intentionally skipped here per the user's explicit instruction to NOT
   touch `background.ts`.

4. **DOM selector fragility**. `.msg-s-event-listitem__body` is a
   LinkedIn CSS class that has churned in the past. The DOM observer
   degrades gracefully through three selectors before giving up, but
   any hard reliance on a specific class will break eventually. The
   Voyager fetch interceptor is the durable contract; the DOM observer
   is the soft fallback.

## Not committed

Per the user instruction, no commits were made. Files are present in the
working tree on this worktree branch.
