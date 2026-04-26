#!/usr/bin/env node
/**
 * bootstrap-gcal-oauth — one-time Google Calendar OAuth refresh-token capture
 * for Kevin's two Google accounts (kevin-elzarka + kevin-taleforge).
 *
 * Usage:
 *   GCAL_CLIENT_ID=...  \
 *   GCAL_CLIENT_SECRET=... \
 *     node scripts/bootstrap-google-oauth.mjs --account kevin-elzarka
 *
 *   (run again with --account kevin-taleforge for the second calendar)
 *
 * Prerequisites:
 *   1. GCP project with the Google Calendar API enabled
 *   2. OAuth 2.0 Client ID of type "Web application" — authorised redirect URI
 *      MUST include http://127.0.0.1:9788/callback
 *   3. The signed-in Google account at consent time IS Kevin's matching
 *      identity (kevin@elzarka.com or kevin@tale-forge.app).
 *
 * Flow:
 *   1. Print the consent URL (caller xdg-opens it or pastes into browser).
 *   2. Spin up a local HTTP listener on 127.0.0.1:9788.
 *   3. Google redirects with ?code=... — capture (with state-mismatch guard).
 *   4. Exchange code → refresh_token via oauth2.googleapis.com/token.
 *   5. Write Secrets Manager kos/gcal-oauth-<account>:
 *        { client_id, client_secret, refresh_token }
 *
 * Scopes:
 *   - https://www.googleapis.com/auth/calendar.readonly  (calendar-reader)
 *   - https://www.googleapis.com/auth/gmail.modify       (gmail read + label
 *                                                         + archive + trash)
 *   - https://www.googleapis.com/auth/gmail.send         (send + attachments)
 *
 * gmail.modify covers: read inbox, mark read/unread, apply/remove labels,
 * archive (remove INBOX label), move to trash (auto-purges in 30 days).
 * gmail.send covers: send messages with attachments. Permanent delete is
 * NOT in either scope — switch to https://mail.google.com/ if you need it.
 *
 * Mutation-executor + publisher + content-writer Lambdas have NO Google
 * auth scope at all (T-08-CAL-01 mitigation).
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const accountIdx = argv.indexOf('--account');
if (accountIdx === -1 || !argv[accountIdx + 1]) {
  console.error('usage: --account kevin-elzarka|kevin-taleforge');
  process.exit(2);
}
const account = argv[accountIdx + 1];
if (account !== 'kevin-elzarka' && account !== 'kevin-taleforge') {
  console.error(
    `invalid account "${account}" — must be kevin-elzarka or kevin-taleforge`,
  );
  process.exit(2);
}

const clientId = process.env.GCAL_CLIENT_ID;
const clientSecret = process.env.GCAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    'GCAL_CLIENT_ID and GCAL_CLIENT_SECRET must be set in the environment.\n' +
      'Create them via:\n' +
      '  https://console.cloud.google.com/apis/credentials\n' +
      '  → Create Credentials → OAuth client ID → Web application',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// OAuth consent URL
// ---------------------------------------------------------------------------
const redirectUri = 'http://127.0.0.1:9788/callback';
const scope = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');
const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // forces refresh_token re-issue
authUrl.searchParams.set('state', state);

console.log(
  `\nOpen this URL in your browser (or xdg-open / pbcopy it):\n\n${authUrl.toString()}\n`,
);
console.log(
  `Waiting on http://127.0.0.1:9788/callback for the OAuth redirect...\n`,
);

// ---------------------------------------------------------------------------
// Local listener: capture ?code=
// ---------------------------------------------------------------------------
const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1:9788');
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (reqUrl.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('state mismatch');
      reject(new Error('state mismatch — possible CSRF; abort.'));
      return;
    }
    const errParam = reqUrl.searchParams.get('error');
    if (errParam) {
      res
        .writeHead(400, { 'Content-Type': 'text/plain' })
        .end(`OAuth error: ${errParam}`);
      reject(new Error(`OAuth error: ${errParam}`));
      return;
    }
    const c = reqUrl.searchParams.get('code');
    if (!c) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('no code');
      reject(new Error('no code in callback'));
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><html><body style="font-family: system-ui">` +
          `<h1>KOS OAuth capture complete</h1>` +
          `<p>Account: <code>${account}</code></p>` +
          `<p>You may close this tab and return to the terminal.</p>` +
          `</body></html>`,
      );
    server.close();
    resolve(c);
  });
  server.on('error', reject);
  server.listen(9788, '127.0.0.1');
});

// ---------------------------------------------------------------------------
// Code → refresh_token exchange
// ---------------------------------------------------------------------------
const tokBody = new URLSearchParams({
  code,
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: redirectUri,
  grant_type: 'authorization_code',
});
const tokResp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: tokBody,
});
if (!tokResp.ok) {
  console.error(`Google token exchange failed (${tokResp.status}):`);
  console.error(await tokResp.text());
  process.exit(3);
}
const tok = await tokResp.json();
if (!tok.refresh_token) {
  console.error(
    'Google did NOT return a refresh_token. This usually means the user has\n' +
      'already granted consent for this client. Revoke at:\n' +
      '  https://myaccount.google.com/permissions\n' +
      'then re-run this script (we set prompt=consent + access_type=offline).',
  );
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Write Secrets Manager kos/gcal-oauth-<account>
// ---------------------------------------------------------------------------
const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});
const secretId = `kos/gcal-oauth-${account}`;
const payload = JSON.stringify({
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: tok.refresh_token,
});

try {
  await sm.send(
    new PutSecretValueCommand({ SecretId: secretId, SecretString: payload }),
  );
  console.log(`Updated existing secret: ${secretId}`);
} catch (e) {
  if (e?.name === 'ResourceNotFoundException') {
    await sm.send(
      new CreateSecretCommand({
        Name: secretId,
        SecretString: payload,
        Description: `Google OAuth (calendar.readonly + gmail.modify + gmail.send) for ${account}`,
      }),
    );
    console.log(`Created secret: ${secretId}`);
  } else {
    throw e;
  }
}

console.log(
  `\nVerify with:\n` +
    `  aws secretsmanager get-secret-value --secret-id ${secretId} \\\n` +
    `    --query SecretString --output text | jq '.refresh_token' | head -c 24\n`,
);
