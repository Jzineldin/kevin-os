#!/usr/bin/env node
/**
 * bootstrap-gcal-oauth — one-time OAuth refresh-token capture for Kevin's
 * two Google Calendar accounts.
 *
 * Usage: node scripts/bootstrap-gcal-oauth.mjs --account kevin-elzarka
 *        node scripts/bootstrap-gcal-oauth.mjs --account kevin-taleforge
 *
 * Flow (full impl in Plan 08-01):
 *  1. Open Google OAuth consent URL (localhost redirect_uri)
 *  2. Capture authorization code from local HTTP listener on 127.0.0.1:9788
 *  3. Exchange code → refresh_token
 *  4. Write to Secrets Manager kos/gcal-oauth-<account> as JSON:
 *       { client_id, client_secret, refresh_token }
 *  5. Print success + a curl verification one-liner
 *
 * Scope: https://www.googleapis.com/auth/calendar.readonly ONLY.
 * Mutation-executor + publisher + content-writer must NOT have any scope
 * that writes to Google Calendar.
 */
console.error(
  'scripts/bootstrap-gcal-oauth.mjs — stub. Full implementation in Phase 8 Plan 08-01.',
);
console.error(
  'This scaffolds the operator flow; run after Plan 08-01 ships.',
);
process.exit(1);
