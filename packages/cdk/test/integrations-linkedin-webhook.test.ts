/**
 * Plan 05-02 synth-level assertions for the LinkedIn DM webhook (CAP-05).
 * Verifies:
 *   - Lambda function with timeout 10s + memory 256MB + arm64 + nodejs22.x.
 *   - Lambda env has BEARER_SECRET_ARN + HMAC_SECRET_ARN.
 *   - Function URL with AuthType: NONE + InvokeMode: BUFFERED.
 *   - Two Secrets Manager entries:
 *       kos/linkedin-webhook-bearer
 *       kos/linkedin-webhook-hmac
 *   - IAM grants: secretsmanager:GetSecretValue on BOTH secrets,
 *     events:PutEvents on the kos.capture bus.
 *   - NEGATIVE: no bedrock:* / ses:* / dynamodb:* in the Lambda's policy.
 *   - CfnOutput LinkedInWebhookUrl with export KosLinkedInWebhookUrl.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — LinkedIn webhook (Plan 05-02)', () => {
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
    const integrations = new IntegrationsStack(app, 'KosIntegrations', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      captureBus: events.buses.capture,
      systemBus: events.buses.system,
      scheduleGroupName: events.scheduleGroupName,
      enableLinkedInWebhook: true,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  function findLinkedInLambda(tpl: Template): {
    Properties: {
      Timeout: number;
      MemorySize: number;
      Architectures: string[];
      Runtime: string;
      Environment?: { Variables?: Record<string, unknown> };
    };
  } {
    const fns = tpl.findResources('AWS::Lambda::Function');
    const found = Object.values(fns).find((f) => {
      const e = (
        f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return e !== undefined && 'BEARER_SECRET_ARN' in e && 'HMAC_SECRET_ARN' in e;
    });
    if (!found) throw new Error('linkedin-webhook Lambda not found');
    return found as never;
  }

  it('synthesises a Lambda with 10s timeout + 256MB memory + arm64 + nodejs22.x', () => {
    const { tpl } = synth();
    const fn = findLinkedInLambda(tpl);
    expect(fn.Properties.Timeout).toBe(10);
    expect(fn.Properties.MemorySize).toBe(256);
    expect(fn.Properties.Architectures).toEqual(['arm64']);
    expect(fn.Properties.Runtime).toBe('nodejs22.x');
  });

  it('Lambda env carries BEARER_SECRET_ARN and HMAC_SECRET_ARN', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            BEARER_SECRET_ARN: Match.anyValue(),
            HMAC_SECRET_ARN: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it('creates a Lambda Function URL with AuthType: NONE + InvokeMode: BUFFERED', () => {
    const { tpl } = synth();
    const urls = tpl.findResources('AWS::Lambda::Url');
    const liUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string } }).Properties;
      return props.AuthType === 'NONE';
    });
    expect(liUrl).toBeDefined();
    const props = (
      liUrl as { Properties: { AuthType: string; InvokeMode: string } }
    ).Properties;
    expect(props.AuthType).toBe('NONE');
    expect(props.InvokeMode).toBe('BUFFERED');
  });

  it('creates kos/linkedin-webhook-bearer + kos/linkedin-webhook-hmac Secrets', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::SecretsManager::Secret',
      Match.objectLike({ Name: 'kos/linkedin-webhook-bearer' }),
    );
    tpl.hasResourceProperties(
      'AWS::SecretsManager::Secret',
      Match.objectLike({ Name: 'kos/linkedin-webhook-hmac' }),
    );
  });

  it('Lambda role has secretsmanager:GetSecretValue on BOTH secrets', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const liPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('LinkedInWebhook'),
    );
    const serialised = JSON.stringify(liPolicies);
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    expect(serialised).toMatch(/LinkedInWebhookBearer/);
    expect(serialised).toMatch(/LinkedInWebhookHmac/);
  });

  it('Lambda role has events:PutEvents on the kos.capture bus', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const liPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('LinkedInWebhook'),
    );
    const serialised = JSON.stringify(liPolicies);
    expect(serialised).toContain('events:PutEvents');
    expect(serialised.toLowerCase()).toMatch(/capture/);
  });

  it('Lambda role has NO bedrock:* / ses:* / dynamodb:* (defence in depth)', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const liPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('LinkedInWebhook'),
    );
    expect(liPolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(liPolicies);
    expect(serialised).not.toMatch(/"bedrock:/);
    expect(serialised).not.toMatch(/"ses:/);
    expect(serialised).not.toMatch(/"dynamodb:/);
  });

  it('emits a LinkedInWebhookUrl CfnOutput with export KosLinkedInWebhookUrl', () => {
    const { tpl } = synth();
    tpl.hasOutput(
      'LinkedInWebhookUrl',
      Match.objectLike({
        Export: Match.objectLike({ Name: 'KosLinkedInWebhookUrl' }),
      }),
    );
  });

  it('does NOT synthesise the LinkedIn webhook when enableLinkedInWebhook is unset', () => {
    const app = new App();
    const net = new NetworkStack(app, 'KosNetwork', { env });
    const events = new EventsStack(app, 'KosEvents', { env });
    const data = new DataStack(app, 'KosData', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const integrations = new IntegrationsStack(app, 'KosIntegrations', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      captureBus: events.buses.capture,
      systemBus: events.buses.system,
      scheduleGroupName: events.scheduleGroupName,
      // enableLinkedInWebhook intentionally omitted
    });
    const tpl = Template.fromStack(integrations);
    // No secrets named with linkedin-webhook prefix.
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const linkedInSecrets = Object.values(secrets).filter((s) => {
      const name = (s as { Properties?: { Name?: string } }).Properties?.Name;
      return typeof name === 'string' && name.includes('linkedin-webhook');
    });
    expect(linkedInSecrets).toHaveLength(0);
    // No CfnOutput KosLinkedInWebhookUrl.
    expect(tpl.findOutputs('LinkedInWebhookUrl')).toEqual({});
  });
});
