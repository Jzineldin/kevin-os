/**
 * Gmail OAuth client + signature/From-header reader (Plan 02-09 / ENT-06).
 *
 * Reads From: headers + 200-char snippets from kevin@tale-forge.app over the
 * last 90 days using `gmail.readonly` scope. Tokens stored in
 * `kos/gmail-oauth-tokens` Secrets Manager secret as JSON
 * `{client_id, client_secret, refresh_token}`.
 *
 * T-02-BULK-02 mitigation: we use `format: 'metadata'` with
 * `metadataHeaders: ['From']` only — the Gmail API returns no message body
 * payload. Snippet (≤ 200 chars) is part of the metadata response and is
 * sufficient context for the person extractor.
 *
 * T-02-BULK-10 mitigation: tokens fetched at runtime from Secrets Manager,
 * never logged. The `buildGmailClient` factory throws (graceful) if the
 * secret is missing — handler catches and skips Gmail leg.
 */

import { google, type gmail_v1 } from 'googleapis';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

export interface GmailTokens {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export async function loadGmailTokens(
  secretId = process.env.GMAIL_OAUTH_SECRET_ID ?? 'kos/gmail-oauth-tokens',
): Promise<GmailTokens> {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!r.SecretString) throw new Error(`Gmail OAuth secret ${secretId} empty`);
  const parsed = JSON.parse(r.SecretString) as Partial<GmailTokens>;
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error(
      `Gmail OAuth secret ${secretId} missing required fields {client_id, client_secret, refresh_token} — run scripts/gmail-oauth-init.ts to populate`,
    );
  }
  return parsed as GmailTokens;
}

export async function buildGmailClient(
  tokens?: GmailTokens,
): Promise<gmail_v1.Gmail> {
  const t = tokens ?? (await loadGmailTokens());
  const oauth2 = new google.auth.OAuth2(t.client_id, t.client_secret);
  oauth2.setCredentials({ refresh_token: t.refresh_token });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

export interface GmailFromMessage {
  from: string;
  snippet: string;
  messageId: string;
}

/**
 * Yield From: headers + snippets from messages within the last `daysBack`
 * days. Uses `format: 'metadata'` to keep cost bounded — no bodies fetched.
 */
export async function* readGmailSignatures(
  gmail: gmail_v1.Gmail,
  daysBack = 90,
): AsyncGenerator<GmailFromMessage> {
  const q = `newer_than:${daysBack}d`;
  let pageToken: string | undefined;

  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 500,
      ...(pageToken ? { pageToken } : {}),
    });
    const msgs = list.data.messages ?? [];
    for (const m of msgs) {
      if (!m.id) continue;
      try {
        const got = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From'],
        });
        const headers = got.data.payload?.headers ?? [];
        const fromHeader =
          headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
        const snippet = got.data.snippet ?? '';
        if (fromHeader) {
          yield { from: fromHeader, snippet, messageId: m.id };
        }
      } catch (err) {
        // One bad message shouldn't kill the whole stream — log + continue.
        console.warn(
          `[bulk-gmail] messages.get failed for ${m.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);
}
