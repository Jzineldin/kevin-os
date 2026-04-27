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
    systemBus: events.buses.system,
    kevinTelegramUserId: '111222333',
    kosChatEndpoint: 'https://kos-dashboard-navy.vercel.app/api/chat',
    kosDashboardBearerSecret: data.dashboardBearerSecret,
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

  // --- Plan 02-02: transcribe pipeline assertions --------------------------

  it('CaptureReceivedVoiceRule has detail.kind=voice pattern + DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const voiceRule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | { source?: string[]; 'detail-type'?: string[]; detail?: { kind?: string[] } }
        | undefined;
      return (
        ep?.source?.includes('kos.capture') === true &&
        ep?.['detail-type']?.includes('capture.received') === true &&
        ep?.detail?.kind?.includes('voice') === true
      );
    });
    expect(voiceRule).toBeDefined();
    const targets = (voiceRule as { Properties?: { Targets?: unknown[] } })
      .Properties?.Targets as { DeadLetterConfig?: { Arn?: unknown } }[];
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  it('TranscribeJobStateChangeRule filters source=aws.transcribe + kos- prefix', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const completionRule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | { source?: string[]; 'detail-type'?: string[] }
        | undefined;
      return (
        ep?.source?.includes('aws.transcribe') === true &&
        ep?.['detail-type']?.includes('Transcribe Job State Change') === true
      );
    });
    expect(completionRule).toBeDefined();
    const ep = (completionRule as { Properties: { EventPattern: { detail: { TranscriptionJobName: { prefix: string }[] } } } })
      .Properties.EventPattern;
    expect(ep.detail.TranscriptionJobName[0]?.prefix).toBe('kos-');
    const targets = (completionRule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  it('TranscribeStarter + TranscribeComplete Lambdas use nodejs22.x + arm64', () => {
    const fns = tpl.findResources('AWS::Lambda::Function');
    const transcribeFns = Object.values(fns).filter((f) => {
      const env = (f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables;
      // transcribe lambdas have BLOBS_BUCKET but NOT TELEGRAM_BOT_TOKEN_SECRET_ARN.
      return (
        env?.BLOBS_BUCKET !== undefined &&
        env?.TELEGRAM_BOT_TOKEN_SECRET_ARN === undefined
      );
    });
    expect(transcribeFns.length).toBeGreaterThanOrEqual(2);
    for (const fn of transcribeFns) {
      const props = (fn as { Properties: { Runtime: string; Architectures: string[] } }).Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('TranscribeStarter has transcribe:StartTranscriptionJob policy', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('transcribe:StartTranscriptionJob');
  });

  it('TranscribeComplete has transcribe:GetTranscriptionJob + PutEvents on capture and system buses', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const completePolicy = Object.entries(policies).find(([name]) =>
      name.startsWith('TranscribeCompleteServiceRoleDefaultPolicy'),
    );
    expect(completePolicy).toBeDefined();
    const [, policyRes] = completePolicy as [string, { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } }];
    const statements = policyRes.Properties.PolicyDocument.Statement;
    expect(
      statements.some((s) => s.Action === 'transcribe:GetTranscriptionJob'),
    ).toBe(true);
    const putEvents = statements.filter((s) => s.Action === 'events:PutEvents');
    // Two PutEvents grants — one per bus (capture + system). Bus ARNs are
    // Fn::ImportValue tokens pointing at EventsStack exports; the two exports
    // have distinct logical IDs.
    expect(putEvents.length).toBe(2);
    const serialized = JSON.stringify(putEvents);
    expect(serialized).toMatch(/KosBuscaptureBus/);
    expect(serialized).toMatch(/KosBussystemBus/);
  });

  it('creates dedicated transcribe DLQs (pipeline-scoped, not shared with capture)', () => {
    const queues = tpl.findResources('AWS::SQS::Queue');
    const names = Object.values(queues).map(
      (q) => (q as { Properties?: { QueueName?: string } }).Properties?.QueueName,
    );
    expect(names).toContain('kos-transcribe-starter-dlq');
    expect(names).toContain('kos-transcribe-complete-dlq');
  });
});
