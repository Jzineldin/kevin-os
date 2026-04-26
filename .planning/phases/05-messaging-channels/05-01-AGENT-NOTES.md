# Phase 5 Plan 05-01 — Agent Notes

**Plan:** Chrome extension highlight + chrome-webhook Lambda (CAP-04)
**Branch:** `worktree-agent-a7d7a50e6a82b11e4` (off master, with `phase-05-plan-00-scaffold` merged in)
**Status:** Implemented + tested + typechecked. NOT committed.

## What was built

### `apps/chrome-extension/` (Chrome MV3 extension)

| File | Purpose |
|------|---------|
| `src/lib/hmac.ts` | Web Crypto HMAC-SHA256 + `signRequest` + `formatSignatureHeader`. Stripe-style canonical `${secret}.${t}.${body}`. Runs unchanged in service worker, content script, options page, AND vitest. |
| `src/lib/storage.ts` | Typed `chrome.storage.local` wrapper — `loadConfig`, `saveConfig`, `isConfigured`. |
| `src/background.ts` | MV3 service worker. Registers context menu on install; handles right-click → "Send to KOS"; mints client-side ULID; signs body; POSTs to `<webhookUrl>/highlight` with Bearer + X-KOS-Signature. Exports `handleContextMenuClick` for direct test invocation. |
| `src/content-highlight.ts` | Minimal sentinel content script (logs one debug line on injection). MV3 contextMenus already gives the SW direct access to `info.selectionText`, so no message-passing needed for the highlight path. |
| `src/options.ts` | Options page: 3 inputs + Save + Test Ping. URL validated via `new URL()`. Test Ping signs a `{test_ping:true}` payload and surfaces the HTTP status to the operator. |
| `src/options.html` | Three inputs (`webhook-url`, `bearer`, `hmac-secret`) + Save + Test Ping buttons. No inline scripts (CSP-safe). |
| `src/manifest.json` | MV3 manifest. Removed `"type": "module"` from `background` (esbuild outputs IIFE). |
| `test/hmac.test.ts` | 5 tests — known SHA-256 HMAC vector, signRequest shape, signature regex, canonical format, header format. |
| `test/highlight.test.ts` | 6 tests — fetch wiring, Bearer + signature headers, body shape, empty selection no-op, chrome:// no-op, wrong menu id no-op, fetch-throws no-rethrow. |
| `test/options.test.ts` | 2 tests — saveConfig/loadConfig roundtrip, isConfigured semantics. |

### `services/chrome-webhook/` (Lambda)

| File | Purpose |
|------|---------|
| `src/handler.ts` | Lambda Function URL handler. Verifies Bearer (constant-time), then HMAC (Stripe-style canonical, ±300s drift), then Zod-parses against `CaptureReceivedChromeHighlightSchema`. Server-mints capture_id + received_at (overrides any client-supplied values). Emits `kos.capture / capture.received { kind: 'chrome_highlight', channel: 'chrome' }`. |
| `src/hmac.ts` | `verifySignature` (matches extension canonical) + `verifyBearer` (constant-time, length-mismatch short-circuit). |
| `src/secrets.ts` | Two cached Secrets Manager loaders for Bearer + HMAC. Fail-closed on PLACEHOLDER. |
| `test/handler.test.ts` | 12 tests — happy path, missing/wrong Bearer, missing/bad/drifted HMAC, non-POST, empty body, invalid JSON, body fails Zod, text > 50K, client capture_id is overridden. |
| `test/hmac.test.ts` | 13 tests — HMAC verifier coverage + Bearer verifier coverage. |

`package.json` updated to add OTel + Langfuse + Arizei deps (matching ios-webhook).
`tsconfig.json` updated to include `_shared/**` + path mappings for OTel/Langfuse/Arizei.

### `packages/cdk/`

| File | Purpose |
|------|---------|
| `lib/stacks/integrations-chrome-webhook.ts` (new) | `wireChromeWebhook` helper. KosLambda outside VPC, 15s timeout, 512MB, arm64. Function URL `authType=NONE` (Bearer + HMAC IS the auth boundary per D-02). NO replay table, NO S3 grants. Emits `ChromeWebhookUrl` CfnOutput. |
| `lib/stacks/integrations-stack.ts` | Imports + invokes `wireChromeWebhook` when both chrome secrets are supplied (synth-gated, preserves existing test fixtures). |
| `lib/stacks/data-stack.ts` | Adds two new Secret placeholders: `kos/chrome-extension-bearer` + `kos/chrome-extension-hmac-secret`. RemovalPolicy.RETAIN like the iOS counterpart. |
| `bin/kos.ts` | Wires the two new chrome secrets from DataStack into IntegrationsStack props. |
| `test/integrations-chrome-webhook.test.ts` (new) | 8 synth-level tests — Lambda shape, env, Function URL AuthType=NONE, IAM grants, defence-in-depth negatives (no bedrock/ses/dynamodb/s3), CfnOutput, gating-by-secrets. |

## HMAC canonical (important deviation note)

**Plan calls for Stripe-style canonical**: `${secret}.${t}.${body}` — different from the Phase 4 iOS `${t}.${body}` shape. The Chrome extension's `lib/hmac.ts` AND the chrome-webhook's `src/hmac.ts` BOTH produce/expect the same Stripe-style canonical, so client + server cannot drift. The Phase 4 iOS pair is left unchanged — sharing one verifier between iOS and Chrome was deferred per plan.

## Plan deviations / decisions

1. **No replay-cache table on chrome-webhook (CDK)** — plan called for Bearer + HMAC only. The dashboard's downstream `capture_id` dedupe absorbs accidental double-clicks. Threat T-05-01-05 (DoS) explicitly accepted in plan.
2. **`@types/chrome` already in scaffold** — used the existing `^0.0.270`. The MV3 stub at `@kos/test-fixtures/installMV3Stub` doesn't expose `runtime.onInstalled`, so I optional-chained the listener-add calls (`chrome.runtime.onInstalled?.addListener(...)`). At runtime in a real browser both are guaranteed; the optional chain is a no-op.
3. **`background.ts` exports `handleContextMenuClick`** — direct invocation in tests is more deterministic than driving the chrome.contextMenus.onClicked stub.
4. **`manifest.json` lost `"type": "module"`** — esbuild bundles to IIFE, and Chrome rejects `type: module` for IIFE bundles. Remove kept the build runnable as-is.
5. **Server overrides `capture_id`** — the client mints one for tracing locally, but the server always replaces it via `ulid()` so a misbehaving client cannot pick a colliding id.
6. **No `replay.ts` in chrome-webhook** — same as #1; v1 trade-off documented in plan.
7. **Default text cap 50_000 bytes** — matches the schema's `text.max(50_000)`. Returns 413 before Zod parse to avoid CPU on a 5MB attack body.

## Test summary (after implementation)

- `pnpm --filter @kos/chrome-extension test` → **13/13 pass**
- `pnpm --filter @kos/chrome-extension typecheck` → **clean**
- `pnpm --filter @kos/chrome-extension build` → **dist/ produced** (background.js, content-highlight.js, content-linkedin.js, options.js, manifest.json, options.html)
- `pnpm --filter @kos/service-chrome-webhook test` → **25/25 pass**
- `pnpm --filter @kos/service-chrome-webhook typecheck` → **clean**
- `pnpm --filter @kos/cdk test -- test/integrations-chrome-webhook.test.ts` → **8/8 pass**
- `pnpm --filter @kos/cdk typecheck` → **clean**
- `pnpm -r test` → **0 failures across full repo**
- `pnpm -r typecheck` → **clean across full repo**

## Operator runbook (post-merge, post-deploy)

1. After CDK deploy with `chromeExtensionBearerSecret` + `chromeExtensionHmacSecret` flowing into IntegrationsStack:
   ```
   aws secretsmanager put-secret-value \
     --secret-id kos/chrome-extension-bearer \
     --secret-string "$(openssl rand -hex 32)"
   aws secretsmanager put-secret-value \
     --secret-id kos/chrome-extension-hmac-secret \
     --secret-string "$(openssl rand -hex 32)"
   ```
2. Read CFN output `KosChromeWebhookUrl`.
3. `pnpm --filter @kos/chrome-extension build`.
4. Chrome → `chrome://extensions` → Developer mode → Load unpacked → `apps/chrome-extension/dist/`.
5. Right-click extension icon → Options → paste URL + Bearer + HMAC → Save → Send test ping (expect 4xx `invalid_body`, which proves auth passed).
6. Highlight any text on any web page → right-click → "Send to KOS". Capture lands on the kos.capture bus as `capture.received` with `kind=chrome_highlight, channel=chrome`.

## Files modified

- `apps/chrome-extension/src/manifest.json`
- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/src/content-highlight.ts`
- `apps/chrome-extension/src/options.ts`
- `apps/chrome-extension/src/options.html`
- `apps/chrome-extension/src/lib/hmac.ts` (new)
- `apps/chrome-extension/src/lib/storage.ts` (new)
- `apps/chrome-extension/test/hmac.test.ts` (new)
- `apps/chrome-extension/test/highlight.test.ts` (new)
- `apps/chrome-extension/test/options.test.ts` (new)
- `services/chrome-webhook/package.json`
- `services/chrome-webhook/tsconfig.json`
- `services/chrome-webhook/src/handler.ts`
- `services/chrome-webhook/src/hmac.ts` (new)
- `services/chrome-webhook/src/secrets.ts` (new)
- `services/chrome-webhook/test/handler.test.ts`
- `services/chrome-webhook/test/hmac.test.ts` (new)
- `packages/cdk/lib/stacks/integrations-chrome-webhook.ts` (new)
- `packages/cdk/lib/stacks/integrations-stack.ts`
- `packages/cdk/lib/stacks/data-stack.ts`
- `packages/cdk/bin/kos.ts`
- `packages/cdk/test/integrations-chrome-webhook.test.ts` (new)

## Not committed

Per task instructions, no commit was made. The worktree branch is ready for review + commit.
