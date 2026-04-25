/**
 * Telegram bot ingress wiring helper for CaptureStack (Plan 02-01, CAP-01).
 *
 * Installs:
 *   - `telegram-bot` Lambda (grammY webhook handler; outside the VPC per D-05)
 *   - API Gateway v2 HTTP API with POST /telegram-webhook route → Lambda
 *   - IAM grants: read on 3 Secrets, Put on `audio/*` S3 prefix, PutEvents on
 *     the capture bus
 *
 * The Telegram webhook URL is emitted as a CloudFormation Output so the
 * operator-run `scripts/register-telegram-webhook.mjs` can look it up and
 * call Telegram's setWebhook.
 */

import { Duration, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireTelegramProps {
  blobsBucket: IBucket;
  telegramBotTokenSecret: ISecret;
  telegramWebhookSecret: ISecret;
  sentryDsnSecret: ISecret;
  captureBus: EventBus;
  kevinTelegramUserId: string;
}

export interface TelegramWiring {
  bot: KosLambda;
  httpApi: HttpApi;
  webhookUrl: string;
}

export function wireTelegramIngress(scope: Construct, props: WireTelegramProps): TelegramWiring {
  const bot = new KosLambda(scope, 'TelegramBot', {
    entry: svcEntry('telegram-bot'),
    timeout: Duration.seconds(15),
    memory: 512,
    bundlingOverrides: {
      // grammY v1.42 shim.node.js hard-requires node-fetch@2 which crashes
      // on Node 22 with "Expected signal to be an instanceof AbortSignal".
      // Alias node-fetch → our local shim that re-exports globalThis.fetch.
      //
      // Uses a path relative to the workspace root (esbuild's cwd at synth
      // time) so the resulting asset hash is stable across dev machines and
      // CI — an absolute path would bake the host filesystem into the hash.
      alias: {
        'node-fetch': './services/telegram-bot/src/node-fetch-shim.ts',
      },
    },
    environment: {
      TELEGRAM_BOT_TOKEN_SECRET_ARN: props.telegramBotTokenSecret.secretArn,
      TELEGRAM_WEBHOOK_SECRET_ARN: props.telegramWebhookSecret.secretArn,
      SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn,
      BLOBS_BUCKET: props.blobsBucket.bucketName,
      KEVIN_TELEGRAM_USER_ID: props.kevinTelegramUserId,
    },
  });

  // Grants — T-02-WEBHOOK-03: secrets via Secrets Manager, never env.
  props.telegramBotTokenSecret.grantRead(bot);
  props.telegramWebhookSecret.grantRead(bot);
  props.sentryDsnSecret.grantRead(bot);
  // T-02-S3-01: bucket grants restricted to the `audio/*` key prefix.
  props.blobsBucket.grantPut(bot, 'audio/*');
  // D-04: only PutEvents to the capture bus.
  props.captureBus.grantPutEventsTo(bot);

  const httpApi = new HttpApi(scope, 'TelegramWebhookApi', {
    description: 'KOS Telegram bot webhook (CAP-01)',
    corsPreflight: {
      allowOrigins: ['https://api.telegram.org'],
      allowMethods: [CorsHttpMethod.POST],
    },
  });
  httpApi.addRoutes({
    path: '/telegram-webhook',
    methods: [HttpMethod.POST],
    integration: new HttpLambdaIntegration('TelegramWebhookInt', bot),
  });

  const webhookUrl = `${httpApi.apiEndpoint}/telegram-webhook`;
  new CfnOutput(scope, 'TelegramWebhookUrl', {
    value: webhookUrl,
    exportName: 'KosTelegramWebhookUrl',
  });

  return { bot, httpApi, webhookUrl };
}
