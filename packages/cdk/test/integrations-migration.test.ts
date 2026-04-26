/**
 * Plan 10-00 synth-level assertions for the Phase-10 MigrationStack.
 *
 * Verifies the Wave-0 surface that downstream waves rely on:
 *   - 3 Lambda functions (VpsClassifyMigration, DiscordBrainDump,
 *     N8nWorkflowArchiver) all on nodejs22.x + arm64
 *   - 1 Lambda Function URL with AuthType=NONE (HMAC validated in code)
 *   - 1 EventBridge Scheduler `discord-brain-dump-poll` rate(5 minutes)
 *   - 1 KMS-encrypted S3 archive bucket + 1 DynamoDB cursor table
 *
 * Tests that DON'T fire here (deferred to Wave 1+):
 *   - HMAC-secret rotation tests (Plan 10-01)
 *   - Discord token / channel-list tests (Plan 10-04)
 *   - Operator-role bucket ACL (Plan 10-05)
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { EventsStack } from '../lib/stacks/events-stack';
import { MigrationStack } from '../lib/stacks/integrations-migration';

describe('MigrationStack — Phase 10 Plan 10-00 scaffold', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
    const app = new App();
    const events = new EventsStack(app, 'KosEvents', { env });
    const migration = new MigrationStack(app, 'KosMigration', {
      env,
      captureBus: events.buses.capture,
      kevinOwnerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      discordChannelIds: ['9876543210987654321'],
    });
    return { tpl: Template.fromStack(migration) };
  }

  it('emits 3 Lambda functions (VPS adapter + Discord poller + n8n archiver)', () => {
    const { tpl } = synth();
    const fns = tpl.findResources('AWS::Lambda::Function');
    // Each KosLambda construct synthesises ONE AWS::Lambda::Function. The
    // stack creates 3; CDK does not add a "log retention" function in our
    // KosLambda config (logRetention is set via aws_logs construct, not the
    // legacy logRetention prop).
    const userFns = Object.entries(fns).filter(([id]) =>
      /^(VpsClassifyMigration|DiscordBrainDump|N8nWorkflowArchiver)/.test(id),
    );
    expect(userFns).toHaveLength(3);
    for (const [, fn] of userFns) {
      const props = (
        fn as {
          Properties: {
            Runtime: string;
            Architectures: string[];
          };
        }
      ).Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('emits a Lambda Function URL with AuthType: NONE for the VPS adapter', () => {
    const { tpl } = synth();
    const urls = tpl.findResources('AWS::Lambda::Url');
    const noneUrls = Object.values(urls).filter((u) => {
      const p = (u as { Properties: { AuthType: string } }).Properties;
      return p.AuthType === 'NONE';
    });
    expect(noneUrls.length).toBeGreaterThanOrEqual(1);
    tpl.hasResourceProperties(
      'AWS::Lambda::Url',
      Match.objectLike({
        AuthType: 'NONE',
        InvokeMode: 'BUFFERED',
      }),
    );
  });

  it('emits an EventBridge Scheduler discord-brain-dump-poll rate(5 minutes)', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'discord-brain-dump-poll',
        ScheduleExpression: 'rate(5 minutes)',
        State: 'ENABLED',
      }),
    );
  });

  it('emits a KMS-encrypted archive bucket + DynamoDB cursor table', () => {
    const { tpl } = synth();
    // Bucket — must use KMS encryption + BlockPublicAccess.
    tpl.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: 'aws:kms',
              }),
            }),
          ]),
        }),
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        }),
      }),
    );
    // DynamoDB cursor table — PAY_PER_REQUEST + TTL on `ttl`.
    tpl.hasResourceProperties(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: Match.objectLike({
          AttributeName: 'ttl',
          Enabled: true,
        }),
      }),
    );
  });

  it('Lambda env carries the expected wiring vars (no behavioural assumptions)', () => {
    const { tpl } = synth();
    const fns = tpl.findResources('AWS::Lambda::Function');
    const vpsFn = Object.entries(fns).find(([id]) => id.startsWith('VpsClassifyMigration'));
    const discFn = Object.entries(fns).find(([id]) => id.startsWith('DiscordBrainDump'));
    const archFn = Object.entries(fns).find(([id]) => id.startsWith('N8nWorkflowArchiver'));
    expect(vpsFn).toBeDefined();
    expect(discFn).toBeDefined();
    expect(archFn).toBeDefined();
    const vpsEnv = (
      vpsFn![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } }
    ).Properties.Environment.Variables;
    expect(vpsEnv).toHaveProperty('HMAC_SECRET_ARN');
    expect(vpsEnv).toHaveProperty('KOS_CAPTURE_BUS_NAME');
    const discEnv = (
      discFn![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } }
    ).Properties.Environment.Variables;
    expect(discEnv).toHaveProperty('DISCORD_BOT_TOKEN_SECRET_ARN');
    expect(discEnv).toHaveProperty('CURSOR_TABLE_NAME');
    const archEnv = (
      archFn![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } }
    ).Properties.Environment.Variables;
    expect(archEnv).toHaveProperty('ARCHIVE_BUCKET_NAME');
    expect(archEnv).toHaveProperty('ARCHIVE_PREFIX');
    expect(archEnv).toHaveProperty('KMS_KEY_ID');
  });
});
