#!/usr/bin/env -S npx tsx
/**
 * One-time Gmail OAuth consent (Plan 02-09 / ENT-06 / Assumption A10).
 *
 * Prints the consent URL; operator opens it as kevin@tale-forge.app, grants
 * `gmail.readonly`, pastes the resulting code back. Exchange yields a
 * refresh token; we persist {client_id, client_secret, refresh_token} JSON
 * to the `kos/gmail-oauth-tokens` secret in AWS Secrets Manager.
 *
 * Run-once per Kevin Gmail account. Lambda fetches the secret on every
 * invocation + uses the refresh token to mint short-lived access tokens.
 *
 * Pre-req: Google Cloud Console → OAuth 2.0 Client ID (Desktop application).
 *   Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env before running.
 *
 * If `tsx` is missing locally: `npx tsx scripts/gmail-oauth-init.ts`.
 */

import { google } from 'googleapis';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { createInterface } from 'node:readline/promises';

const SECRET_ID = process.env.GMAIL_OAUTH_SECRET_ID ?? 'kos/gmail-oauth-tokens';
const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

async function main(): Promise<void> {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? '';
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error(
      '[ERR] Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET first.\n' +
        '      Get them from Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs (Desktop application).',
    );
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob', // out-of-band — operator pastes the code back
  );

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token even on re-auth (A10)
    scope: [SCOPE],
  });

  console.log('\n[1/3] Open this URL in a browser signed in as kevin@tale-forge.app:\n');
  console.log(url);
  console.log('\n[2/3] Approve the gmail.readonly scope, then copy the resulting code.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('[3/3] Paste code: ')).trim();
  rl.close();

  if (!code) {
    console.error('[ERR] Empty code — aborting.');
    process.exit(1);
  }

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      '[ERR] No refresh_token returned. Either:\n' +
        '      (a) you previously consented and Google is short-circuiting; revoke at https://myaccount.google.com/permissions then re-run\n' +
        '      (b) prompt=consent silently elided — try Incognito mode',
    );
    process.exit(1);
  }

  const sm = new SecretsManagerClient({ region: REGION });
  const SecretString = JSON.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
  });

  try {
    await sm.send(
      new PutSecretValueCommand({ SecretId: SECRET_ID, SecretString }),
    );
    console.log(`[OK] gmail-oauth-tokens overwritten in ${SECRET_ID} (${REGION})`);
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await sm.send(
        new CreateSecretCommand({
          Name: SECRET_ID,
          SecretString,
          Description: 'Gmail OAuth tokens for KOS bulk-import (Plan 02-09)',
        }),
      );
      console.log(`[OK] gmail-oauth-tokens created at ${SECRET_ID} (${REGION})`);
    } else {
      throw err;
    }
  }

  console.log(
    `[i] Lambda env may need GMAIL_OAUTH_SECRET_ID=${SECRET_ID} (default already matches).`,
  );
}

main().catch((err) => {
  console.error('[ERR]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
