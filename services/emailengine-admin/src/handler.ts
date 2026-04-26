/**
 * @kos/service-emailengine-admin — operator-facing Lambda for EmailEngine
 * account registration + listing (CAP-07 ops surface, Plan 04-03).
 *
 * Function URL is `authType=AWS_IAM` — only Kevin's operator IAM credentials
 * (or a bastion role) can invoke this. EmailEngine's REST API is reachable
 * only from inside the VPC via Cloud Map private DNS
 * (`emailengine.kos-internal.local:3000`), so this Lambda is VPC-attached.
 *
 * Commands accepted (one of):
 *   { command: 'register-account', account, accountSecretArn }
 *     → reads `{ email, app_password }` from the named Secrets Manager entry
 *       (kos/emailengine-imap-<name>) and POSTs `/v1/account` to EmailEngine
 *       with imap.gmail.com:993 IMAP credentials. NEVER accepts credentials
 *       from the caller payload — the secret arn is the authoritative source.
 *   { command: 'unregister-account', account }
 *     → DELETE /v1/account/{account}
 *   { command: 'list-accounts' }
 *     → GET /v1/accounts
 *
 * The EmailEngine response body is returned verbatim (status + text) so the
 * operator script can surface failures without re-parsing.
 *
 * Secret-payload contract (each kos/emailengine-imap-* secret):
 *   { "email": "kevin.elzarka@gmail.com", "app_password": "xxxx-xxxx-xxxx-xxxx" }
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const AdminCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('register-account'),
    account: z.string().min(1),
    accountSecretArn: z.string().min(1),
  }),
  z.object({
    command: z.literal('unregister-account'),
    account: z.string().min(1),
  }),
  z.object({
    command: z.literal('list-accounts'),
  }),
]);

const ImapSecretSchema = z.object({
  email: z.string().email(),
  app_password: z.string().min(1),
});

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });

interface FnUrlEvent {
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface FnUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function reply(statusCode: number, body: string | Record<string, unknown>): FnUrlResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export const handler = wrapHandler(
  async (event: FnUrlEvent): Promise<FnUrlResponse> => {
    await initSentry();

    const baseUrl = process.env.EE_REST_URL;
    if (!baseUrl) {
      return reply(500, { error: 'EE_REST_URL_unset' });
    }
    const eeApiKeyArn = process.env.EE_API_KEY_SECRET_ARN;
    if (!eeApiKeyArn) {
      return reply(500, { error: 'EE_API_KEY_SECRET_ARN_unset' });
    }

    if (!event.body) {
      return reply(400, { error: 'empty_body' });
    }
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    let parsed: z.infer<typeof AdminCommandSchema>;
    try {
      parsed = AdminCommandSchema.parse(JSON.parse(raw));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'parse_failed';
      return reply(400, { error: 'invalid_command', reason });
    }

    // Resolve the EmailEngine REST API key once per invocation.
    const apiKeyResp = await sm.send(
      new GetSecretValueCommand({ SecretId: eeApiKeyArn }),
    );
    const apiKey = apiKeyResp.SecretString;
    if (!apiKey || apiKey === 'PLACEHOLDER') {
      return reply(500, { error: 'ee_api_key_unset_or_placeholder' });
    }
    const authHeader = { Authorization: `Bearer ${apiKey}` };

    if (parsed.command === 'list-accounts') {
      const r = await fetch(`${baseUrl}/v1/accounts`, { headers: authHeader });
      const text = await r.text();
      return reply(r.status, text);
    }

    if (parsed.command === 'unregister-account') {
      const r = await fetch(
        `${baseUrl}/v1/account/${encodeURIComponent(parsed.account)}`,
        { method: 'DELETE', headers: authHeader },
      );
      const text = await r.text();
      return reply(r.status, text);
    }

    // register-account
    const credResp = await sm.send(
      new GetSecretValueCommand({ SecretId: parsed.accountSecretArn }),
    );
    const credString = credResp.SecretString;
    if (!credString || credString === 'PLACEHOLDER') {
      return reply(500, {
        error: 'imap_secret_unset_or_placeholder',
        secret_arn: parsed.accountSecretArn,
      });
    }
    let cred: z.infer<typeof ImapSecretSchema>;
    try {
      cred = ImapSecretSchema.parse(JSON.parse(credString));
    } catch (err) {
      return reply(500, {
        error: 'imap_secret_malformed',
        reason: err instanceof Error ? err.message : 'parse_failed',
      });
    }

    const payload = {
      account: parsed.account,
      name: parsed.account,
      email: cred.email,
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: cred.email, pass: cred.app_password },
      },
      // Outbound SMTP via SES, not EmailEngine. EE only watches IMAP IDLE.
      smtp: false,
      webhooks: true,
    };

    const r = await fetch(`${baseUrl}/v1/account`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    return reply(r.status, text);
  },
);
