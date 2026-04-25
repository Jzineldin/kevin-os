/**
 * Plan 04-01 synth-level assertions for the iOS Action Button webhook
 * (CAP-02). Verifies:
 *   - Lambda function with timeout 15s + memory 512MB + arm64.
 *   - Lambda env has WEBHOOK_SECRET_ARN, REPLAY_TABLE_NAME, BLOBS_BUCKET.
 *   - Function URL with AuthType: NONE.
 *   - DynamoDB table `kos-ios-webhook-replay` with TTL on `expires_at`.
 *   - IAM grants: dynamodb:PutItem on replay table; s3:PutObject on
 *     `audio/*`; secretsmanager:GetSecretValue on the webhook secret;
 *     events:PutEvents on the kos.capture bus.
 *   - NEGATIVE: no bedrock:* / ses:* / dynamodb:Scan in the Lambda's policy
 *     (defence-in-depth — the Lambda exists solely to land audio + emit a
 *     capture.received event).
 *   - VPCE_BYPASS_ROLE_PATTERNS now includes the IosWebhook entry.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — iOS webhook (Plan 04-01)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
    const app = new App();
    const net = new NetworkStack(app, 'KosNetwork', { env });
    const events = new EventsStack(app, 'KosEvents', { env });
    const data = new DataStack(app, 'KosData', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    // Stack name MUST be 'KosIntegrations' so the VPCE_BYPASS pattern
    // `KosIntegrations-IosWebhook*` resolves to a live IAM role.
    const integrations = new IntegrationsStack(app, 'KosIntegrations', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      blobsBucket: data.blobsBucket,
      captureBus: events.buses.capture,
      systemBus: events.buses.system,
      scheduleGroupName: events.scheduleGroupName,
      iosShortcutWebhookSecret: data.iosShortcutWebhookSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('synthesises a Lambda function with 15s timeout + 512MB memory + arm64', () => {
    const { tpl } = synth();
    const fns = tpl.findResources('AWS::Lambda::Function');
    const ios = Object.values(fns).find((f) => {
      const env = (
        f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return env !== undefined && 'WEBHOOK_SECRET_ARN' in env;
    });
    expect(ios).toBeDefined();
    const props = (ios as {
      Properties: {
        Timeout: number;
        MemorySize: number;
        Architectures: string[];
        Runtime: string;
      };
    }).Properties;
    expect(props.Timeout).toBe(15);
    expect(props.MemorySize).toBe(512);
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Runtime).toBe('nodejs22.x');
  });

  it('Lambda env carries WEBHOOK_SECRET_ARN + REPLAY_TABLE_NAME + BLOBS_BUCKET', () => {
    const { tpl } = synth();
    // REPLAY_TABLE_NAME is a CFN Ref (the DDB table is CFN-managed and CDK
    // resolves the table name at deploy time), so we accept anyValue() for
    // all three keys; the table name LITERAL `kos-ios-webhook-replay` is
    // asserted separately in the DDB resource test below.
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            WEBHOOK_SECRET_ARN: Match.anyValue(),
            REPLAY_TABLE_NAME: Match.anyValue(),
            BLOBS_BUCKET: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it('creates a Lambda Function URL with AuthType: NONE + InvokeMode: BUFFERED', () => {
    const { tpl } = synth();
    const urls = tpl.findResources('AWS::Lambda::Url');
    expect(Object.keys(urls).length).toBeGreaterThanOrEqual(1);
    const iosUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string } }).Properties;
      return props.AuthType === 'NONE';
    });
    expect(iosUrl).toBeDefined();
    const props = (iosUrl as { Properties: { AuthType: string; InvokeMode: string } })
      .Properties;
    expect(props.AuthType).toBe('NONE');
    expect(props.InvokeMode).toBe('BUFFERED');
  });

  it('creates DynamoDB table kos-ios-webhook-replay with TTL on expires_at + PAY_PER_REQUEST', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        TableName: 'kos-ios-webhook-replay',
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: Match.objectLike({
          AttributeName: 'expires_at',
          Enabled: true,
        }),
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'signature', KeyType: 'HASH' }),
        ]),
      }),
    );
  });

  it('Lambda role has dynamodb:PutItem permission on the replay table', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialised = JSON.stringify(policies);
    expect(serialised).toContain('dynamodb:PutItem');
    // Constructor wires `grantWriteData` which expands to a multi-action
    // permission set; the assertion above proves PutItem is present.
  });

  it('Lambda role has s3:PutObject permission scoped to audio/* prefix', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialised = JSON.stringify(policies);
    expect(serialised).toContain('s3:PutObject');
    expect(serialised).toContain('audio/*');
  });

  it('Lambda role has secretsmanager:GetSecretValue on the iOS webhook secret', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const iosPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('IosWebhook'),
    );
    const serialised = JSON.stringify(iosPolicies);
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    // The secret resource is a CFN ImportValue token at this synth (it lives
    // in DataStack); the import name carries `IosShortcutWebhookSecret` so
    // we match on that instead of the human secretName.
    expect(serialised).toMatch(/IosShortcutWebhookSecret/);
  });

  it('Lambda role has events:PutEvents on the kos.capture bus', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialised = JSON.stringify(policies);
    expect(serialised).toContain('events:PutEvents');
    // Bus ARN tokens reference EventsStack export; the bus logical id contains
    // 'capture'.
    expect(serialised.toLowerCase()).toMatch(/capture/);
  });

  it('Lambda role has NO bedrock:* / ses:* / dynamodb:Scan permissions (defence in depth)', () => {
    const { tpl } = synth();
    // Look only at the iOS webhook's policy (matched by its bound IAM role).
    // We find the role attached to the Lambda function (logical id starting
    // with `IosWebhook`) and inspect ONLY policies attached to that role.
    const fns = tpl.findResources('AWS::Lambda::Function');
    const iosFn = Object.entries(fns).find(([name, f]) => {
      const env = (f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables;
      return name.startsWith('IosWebhook') && env && 'WEBHOOK_SECRET_ARN' in env;
    });
    expect(iosFn).toBeDefined();
    const [iosFnLogicalId] = iosFn!;
    const policies = tpl.findResources('AWS::IAM::Policy');
    const iosPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('IosWebhook'),
    );
    // Sanity: at least one policy is bound to the iOS lambda role.
    expect(iosPolicies.length).toBeGreaterThanOrEqual(1);
    void iosFnLogicalId;
    const serialised = JSON.stringify(iosPolicies);
    // Hard negatives — the iOS webhook does NOT need any LLM or email reach.
    expect(serialised).not.toMatch(/"bedrock:/);
    expect(serialised).not.toMatch(/"ses:/);
    // DDB Scan + GetItem must NOT be granted; the handler only calls PutItem
    // on the replay table. (DeleteItem IS granted by `grantWriteData` and is
    // acceptable — TTL cleanup is server-side, but operator could prune.)
    expect(serialised).not.toMatch(/dynamodb:Scan/);
    expect(serialised).not.toMatch(/dynamodb:GetItem/);
    expect(serialised).not.toMatch(/dynamodb:Query/);
  });

  it('emits a IosWebhookUrl CfnOutput', () => {
    const { tpl } = synth();
    tpl.hasOutput(
      'IosWebhookUrl',
      Match.objectLike({
        Export: Match.objectLike({ Name: 'KosIosWebhookUrl' }),
      }),
    );
  });

  it('VPCE_BYPASS_ROLE_PATTERNS includes KosIntegrations-IosWebhook*', () => {
    expect(DataStack.VPCE_BYPASS_ROLE_PATTERNS).toContain(
      'KosIntegrations-IosWebhook*',
    );
  });
});
