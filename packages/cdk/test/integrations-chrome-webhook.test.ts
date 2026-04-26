/**
 * Plan 05-01 synth-level assertions for the Chrome highlight webhook
 * (CAP-04). Verifies:
 *   - Lambda function with timeout 15s + memory 512MB + arm64 + nodejs22.x.
 *   - Lambda env carries CHROME_BEARER_SECRET_ARN + CHROME_HMAC_SECRET_ARN.
 *   - Function URL with AuthType: NONE + InvokeMode: BUFFERED.
 *   - IAM grants: secretsmanager:GetSecretValue on both chrome secrets;
 *     events:PutEvents on the kos.capture bus.
 *   - NEGATIVE: no bedrock:* / ses:* / dynamodb:* / s3:* in the Lambda's
 *     policy (defence-in-depth — the Lambda exists solely to verify the
 *     auth pair + emit a capture.received event).
 *   - Emits a ChromeWebhookUrl CfnOutput.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — chrome webhook (Plan 05-01)', () => {
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
      chromeExtensionBearerSecret: data.chromeExtensionBearerSecret,
      chromeExtensionHmacSecret: data.chromeExtensionHmacSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('synthesises a Lambda with 15s timeout + 512MB + arm64 + nodejs22.x', () => {
    const { tpl } = synth();
    const fns = tpl.findResources('AWS::Lambda::Function');
    const chrome = Object.values(fns).find((f) => {
      const e = (
        f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return e !== undefined && 'CHROME_BEARER_SECRET_ARN' in e;
    });
    expect(chrome).toBeDefined();
    const props = (chrome as {
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

  it('Lambda env carries CHROME_BEARER_SECRET_ARN + CHROME_HMAC_SECRET_ARN', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            CHROME_BEARER_SECRET_ARN: Match.anyValue(),
            CHROME_HMAC_SECRET_ARN: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it('creates a Lambda Function URL with AuthType: NONE + InvokeMode: BUFFERED', () => {
    const { tpl } = synth();
    const urls = tpl.findResources('AWS::Lambda::Url');
    const chromeUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string } }).Properties;
      return props.AuthType === 'NONE';
    });
    expect(chromeUrl).toBeDefined();
    const props = (chromeUrl as { Properties: { AuthType: string; InvokeMode: string } })
      .Properties;
    expect(props.AuthType).toBe('NONE');
    expect(props.InvokeMode).toBe('BUFFERED');
  });

  it('Lambda role has secretsmanager:GetSecretValue on both chrome secrets', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const chromePolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('ChromeWebhook'),
    );
    expect(chromePolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(chromePolicies);
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    expect(serialised).toMatch(/ChromeExtensionBearer/);
    expect(serialised).toMatch(/ChromeExtensionHmacSecret/);
  });

  it('Lambda role has events:PutEvents on the kos.capture bus', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const chromePolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('ChromeWebhook'),
    );
    const serialised = JSON.stringify(chromePolicies);
    expect(serialised).toContain('events:PutEvents');
    expect(serialised.toLowerCase()).toMatch(/capture/);
  });

  it('Lambda role has NO bedrock:* / ses:* / dynamodb:* / s3:* permissions', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const chromePolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('ChromeWebhook'),
    );
    expect(chromePolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(chromePolicies);
    expect(serialised).not.toMatch(/"bedrock:/);
    expect(serialised).not.toMatch(/"ses:/);
    expect(serialised).not.toMatch(/"dynamodb:/);
    expect(serialised).not.toMatch(/"s3:/);
  });

  it('emits a ChromeWebhookUrl CfnOutput', () => {
    const { tpl } = synth();
    tpl.hasOutput(
      'ChromeWebhookUrl',
      Match.objectLike({
        Export: Match.objectLike({ Name: 'KosChromeWebhookUrl' }),
      }),
    );
  });

  it('chrome-webhook is NOT synthesised when secrets are absent', () => {
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
      // Chrome secrets intentionally absent — wiring should be skipped.
    });
    const tpl = Template.fromStack(integrations);
    const fns = tpl.findResources('AWS::Lambda::Function');
    const chrome = Object.values(fns).find((f) => {
      const e = (
        f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return e !== undefined && 'CHROME_BEARER_SECRET_ARN' in e;
    });
    expect(chrome).toBeUndefined();
  });
});
