#!/usr/bin/env node
/**
 * register-telegram-webhook.mjs — operator one-shot.
 *
 * Usage:
 *   AWS_REGION=eu-north-1 node scripts/register-telegram-webhook.mjs
 *
 * Reads the bot token and webhook secret from AWS Secrets Manager, looks up
 * the HTTP API URL emitted by the KosCapture stack, and calls Telegram's
 * setWebhook with `secret_token` set so every future webhook POST carries the
 * `X-Telegram-Bot-Api-Secret-Token` header (T-02-WEBHOOK-01 mitigation).
 *
 * Run this after `cdk deploy KosCapture` and after `scripts/seed-secrets.sh`
 * has written real values into kos/telegram-bot-token and
 * kos/telegram-webhook-secret.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

const region = process.env.AWS_REGION ?? 'eu-north-1';
const sm = new SecretsManagerClient({ region });
const cfn = new CloudFormationClient({ region });

async function getSecret(id) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  if (!r.SecretString || r.SecretString === 'PLACEHOLDER') {
    throw new Error(`secret ${id} not seeded (still PLACEHOLDER)`);
  }
  return r.SecretString;
}

const stacks = await cfn.send(
  new DescribeStacksCommand({ StackName: 'KosCapture' }),
);
const outputs = stacks.Stacks?.[0]?.Outputs ?? [];
const webhookUrl = outputs.find(
  (o) => o.OutputKey === 'TelegramWebhookUrl',
)?.OutputValue;
if (!webhookUrl) {
  throw new Error('TelegramWebhookUrl output not found on KosCapture stack');
}

const botToken = await getSecret('kos/telegram-bot-token');
const webhookSecret = await getSecret('kos/telegram-webhook-secret');

const res = await fetch(
  `https://api.telegram.org/bot${botToken}/setWebhook`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    }),
  },
);
const body = await res.json();
if (!body.ok) {
  console.error('setWebhook failed', body);
  process.exit(1);
}
console.log(`[OK] webhook registered: ${webhookUrl}`);
