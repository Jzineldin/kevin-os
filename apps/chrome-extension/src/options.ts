/**
 * Phase 5 / Plan 05-01 — Options page bootstrap.
 *
 * Three inputs (webhookUrl, bearer, hmacSecret) + Save + Test Ping. All
 * three values land in `chrome.storage.local` (Chrome-encrypted at rest;
 * never reachable from arbitrary web pages). The Test Ping button signs
 * a tiny payload with the same hmac.signRequest used by the highlight
 * fetch, so a 200 response from the operator runbook proves the entire
 * Bearer + HMAC + Lambda wiring is healthy before the operator clicks
 * any actual highlight.
 *
 * No inline scripts in options.html (MV3 CSP forbids inline JS). All
 * event listeners are attached here and bundled to `options.js` via
 * esbuild.
 */
import { loadConfig, saveConfig, type KosConfig } from './lib/storage.js';
import { signRequest, formatSignatureHeader } from './lib/hmac.js';

const SELECTORS = {
  webhookUrl: 'webhook-url',
  bearer: 'bearer',
  hmacSecret: 'hmac-secret',
  save: 'save',
  test: 'test',
  status: 'status',
} as const;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Options page: missing element #${id}`);
  return el;
}
function $input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function showStatus(msg: string, ok: boolean): void {
  const el = $(SELECTORS.status);
  el.textContent = msg;
  el.style.background = ok ? '#e7f9e8' : '#fde7e7';
  el.style.padding = '8px';
  el.style.borderRadius = '4px';
  el.style.marginTop = '12px';
}

async function init(): Promise<void> {
  const cfg = await loadConfig();
  $input(SELECTORS.webhookUrl).value = cfg.webhookUrl ?? '';
  $input(SELECTORS.bearer).value = cfg.bearer ?? '';
  $input(SELECTORS.hmacSecret).value = cfg.hmacSecret ?? '';
}

/**
 * Read inputs, validate, persist via saveConfig. Empty fields → error
 * banner; invalid URL → error banner. No partial writes — all three
 * fields land atomically per the storage.saveConfig contract.
 *
 * Exported for the options.test.ts unit test to invoke directly.
 */
export async function onSave(): Promise<void> {
  const webhookUrl = $input(SELECTORS.webhookUrl).value.trim();
  const bearer = $input(SELECTORS.bearer).value.trim();
  const hmacSecret = $input(SELECTORS.hmacSecret).value.trim();
  if (!webhookUrl || !bearer || !hmacSecret) {
    showStatus('All three fields are required.', false);
    return;
  }
  try {
    new URL(webhookUrl);
  } catch {
    showStatus('Webhook URL is not a valid URL.', false);
    return;
  }
  const cfg: KosConfig = { webhookUrl, bearer, hmacSecret };
  await saveConfig(cfg);
  showStatus('Saved.', true);
}

/**
 * Send a test_ping payload to `<webhookUrl>/highlight`. The Lambda parses
 * the body against `CaptureReceivedChromeHighlightSchema`; the test_ping
 * shape deliberately does NOT match (no `text`/`source_url`/`selected_at`).
 * That is fine — the goal of the test ping is to verify Bearer + HMAC +
 * connectivity reach the Lambda. A 4xx body-validation rejection is just
 * as informative as a 200, because both prove the auth boundary passed.
 *
 * The operator runbook documents that a 4xx with `error: "invalid_body"`
 * (or similar Zod parse failure) on this button means the wiring is good
 * and they can right-click → Send to KOS for real.
 */
export async function onTest(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.webhookUrl || !cfg.bearer || !cfg.hmacSecret) {
    showStatus('Save config first.', false);
    return;
  }
  const body = JSON.stringify({ test_ping: true, at: new Date().toISOString() });
  const signed = await signRequest(body, cfg.hmacSecret);
  const url = `${cfg.webhookUrl.replace(/\/$/, '')}/highlight`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.bearer}`,
        'X-KOS-Signature': formatSignatureHeader(signed),
      },
      body,
    });
    showStatus(
      `Webhook responded ${r.status} ${r.ok ? '(ok)' : '(non-2xx — see Lambda logs)'}.`,
      r.ok,
    );
  } catch (e) {
    showStatus(`Fetch threw: ${(e as Error).message}`, false);
  }
}

// Wire the buttons + run init on import. Guarded so vitest can import the
// module without crashing on missing DOM nodes.
if (typeof document !== 'undefined' && document.getElementById(SELECTORS.save)) {
  $(SELECTORS.save).addEventListener('click', () => {
    void onSave();
  });
  $(SELECTORS.test).addEventListener('click', () => {
    void onTest();
  });
  void init();
}
