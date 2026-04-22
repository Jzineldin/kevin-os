import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { CaptureStack } from '../lib/stacks/capture-stack';

/**
 * CaptureStack synth-level assertions (Plan 02-01, CAP-01 Telegram ingress).
 *
 * Covers:
 *   - API Gateway v2 HTTP API created
 *   - POST /telegram-webhook route present
 *   - telegram-bot Lambda uses nodejs22.x + arm64
 *   - Lambda environment carries 3 required arns + user-id + blobs-bucket
 *   - IAM grants: Secrets Manager read on 3 secrets, PutEvents on capture bus,
 *     and `s3:PutObject*` on `audio/*` prefix of the blobs bucket
 */
describe('CaptureStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const capture = new CaptureStack(app, 'C', {
    env,
    blobsBucket: data.blobsBucket,
    telegramBotTokenSecret: data.telegramBotTokenSecret,
    telegramWebhookSecret: data.telegramWebhookSecret,
    sentryDsnSecret: data.sentryDsnSecret,
    captureBus: events.buses.capture,
    kevinTelegramUserId: '111222333',
  });
  const tpl = Template.fromStack(capture);

  it('creates exactly 1 API Gateway v2 HTTP API', () => {
    const apis = tpl.findResources('AWS::ApiGatewayV2::Api');
    expect(Object.keys(apis).length).toBe(1);
  });

  it('creates a POST /telegram-webhook route', () => {
    tpl.hasResourceProperties(
      'AWS::ApiGatewayV2::Route',
      Match.objectLike({ RouteKey: 'POST /telegram-webhook' }),
    );
  });

  it('telegram-bot Lambda runs nodejs22.x on arm64', () => {
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
      }),
    );
  });

  it('Lambda env has TELEGRAM_BOT_TOKEN_SECRET_ARN, BLOBS_BUCKET, KEVIN_TELEGRAM_USER_ID', () => {
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            TELEGRAM_BOT_TOKEN_SECRET_ARN: Match.anyValue(),
            TELEGRAM_WEBHOOK_SECRET_ARN: Match.anyValue(),
            SENTRY_DSN_SECRET_ARN: Match.anyValue(),
            BLOBS_BUCKET: Match.anyValue(),
            KEVIN_TELEGRAM_USER_ID: '111222333',
          }),
        }),
      }),
    );
  });

  it('Lambda role has events:PutEvents allow statement', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('events:PutEvents');
  });

  it('Lambda role has secretsmanager:GetSecretValue allow statement', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('secretsmanager:GetSecretValue');
  });

  it('Lambda role has s3:PutObject scoped to audio/* prefix', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('s3:PutObject');
    expect(serialized).toContain('audio/*');
  });

  it('emits a TelegramWebhookUrl CfnOutput', () => {
    tpl.hasOutput(
      'TelegramWebhookUrl',
      Match.objectLike({
        Export: Match.objectLike({ Name: 'KosTelegramWebhookUrl' }),
      }),
    );
  });
});
