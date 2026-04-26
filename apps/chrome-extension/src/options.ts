/**
 * @kos/chrome-extension — options page bootstrap (SCAFFOLD).
 *
 * Plan 05-01 wires:
 *   - read/write { webhookUrl, bearer, hmacSecret } from chrome.storage.local
 *   - validate URL + key shapes via zod
 *   - "Test connection" button → background message → chrome-webhook ping
 */
export {};
