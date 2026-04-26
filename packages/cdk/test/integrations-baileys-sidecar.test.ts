/**
 * Plan 05-05 synth-level assertions for the Baileys sidecar (CAP-06).
 *
 * Verifies (8 cases — see Plan 05-05 §Task 2):
 *   1. Lambda function with timeout 30s + memory 512MB + arm64 + nodejs22.x.
 *   2. Function URL with AuthType: NONE + InvokeMode: BUFFERED.
 *   3. Lambda env carries BAILEYS_WEBHOOK_SECRET_ARN + BLOBS_BUCKET +
 *      BAILEYS_MEDIA_BASE_URL.
 *   4. IAM grant: secretsmanager:GetSecretValue on the baileys-webhook-secret.
 *   5. IAM grant: s3:PutObject scoped to audio/* prefix on the blobs bucket.
 *   6. IAM grant: events:PutEvents on the kos.capture bus.
 *   7. NEGATIVE: no bedrock:* / ses:* / rds:* in the Lambda's policy.
 *   8. CfnOutput BaileysSidecarUrl with export KosBaileysSidecarUrl.
 *
 * Plus a synth-gating test confirming the Lambda is NOT created when
 * `enableBaileysSidecar` is unset.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — Baileys sidecar (Plan 05-05)', () => {
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
      blobsBucket: data.blobsBucket,
      enableBaileysSidecar: true,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  function findSidecar(tpl: Template): {
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
        f as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      ).Properties?.Environment?.Variables;
      return e !== undefined && 'BAILEYS_WEBHOOK_SECRET_ARN' in e;
    });
    if (!found) throw new Error('baileys-sidecar Lambda not found');
    return found as never;
  }

  it('synthesises a Lambda with 30s timeout + 512MB + arm64 + nodejs22.x', () => {
    const { tpl } = synth();
    const fn = findSidecar(tpl);
    expect(fn.Properties.Timeout).toBe(30);
    expect(fn.Properties.MemorySize).toBe(512);
    expect(fn.Properties.Architectures).toEqual(['arm64']);
    expect(fn.Properties.Runtime).toBe('nodejs22.x');
  });

  it('creates a Function URL with AuthType: NONE + InvokeMode: BUFFERED', () => {
    const { tpl } = synth();
    const urls = tpl.findResources('AWS::Lambda::Url');
    const sidecarUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string } }).Properties;
      return props.AuthType === 'NONE';
    });
    expect(sidecarUrl).toBeDefined();
    const props = (
      sidecarUrl as { Properties: { AuthType: string; InvokeMode: string } }
    ).Properties;
    expect(props.AuthType).toBe('NONE');
    expect(props.InvokeMode).toBe('BUFFERED');
  });

  it('Lambda env carries BAILEYS_WEBHOOK_SECRET_ARN + BLOBS_BUCKET + BAILEYS_MEDIA_BASE_URL', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            BAILEYS_WEBHOOK_SECRET_ARN: Match.anyValue(),
            BLOBS_BUCKET: Match.anyValue(),
            BAILEYS_MEDIA_BASE_URL: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it('creates kos/baileys-webhook-secret Secret with RemovalPolicy.RETAIN', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::SecretsManager::Secret',
      Match.objectLike({ Name: 'kos/baileys-webhook-secret' }),
    );
    // Confirm the resource has DeletionPolicy=Retain on the CFN side.
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const baileysSecret = Object.values(secrets).find((s) => {
      const name = (s as { Properties?: { Name?: string } }).Properties?.Name;
      return name === 'kos/baileys-webhook-secret';
    });
    expect(baileysSecret).toBeDefined();
    expect(
      (baileysSecret as { DeletionPolicy?: string }).DeletionPolicy,
    ).toBe('Retain');
  });

  it('Lambda role has secretsmanager:GetSecretValue on the baileys-webhook-secret', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sidecarPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('BaileysSidecar'),
    );
    expect(sidecarPolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(sidecarPolicies);
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    expect(serialised).toMatch(/BaileysWebhookSecret/);
  });

  it('Lambda role has s3:PutObject scoped to audio/* prefix on blobsBucket', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sidecarPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('BaileysSidecar'),
    );
    const serialised = JSON.stringify(sidecarPolicies);
    expect(serialised).toContain('s3:PutObject');
    // The grantPut(prefix='audio/*') call appends `/audio/*` to the
    // bucket arn in the resource list.
    expect(serialised).toContain('audio/*');
  });

  it('Lambda role has events:PutEvents on the kos.capture bus', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sidecarPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('BaileysSidecar'),
    );
    const serialised = JSON.stringify(sidecarPolicies);
    expect(serialised).toContain('events:PutEvents');
    expect(serialised.toLowerCase()).toMatch(/capture/);
  });

  it('Lambda role has NO bedrock:* / ses:* / rds:* / dynamodb:* permissions', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sidecarPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('BaileysSidecar'),
    );
    expect(sidecarPolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(sidecarPolicies);
    expect(serialised).not.toMatch(/"bedrock:/);
    expect(serialised).not.toMatch(/"ses:/);
    expect(serialised).not.toMatch(/"rds:/);
    expect(serialised).not.toMatch(/"dynamodb:/);
  });

  it('emits a BaileysSidecarUrl CfnOutput with export KosBaileysSidecarUrl', () => {
    const { tpl } = synth();
    tpl.hasOutput(
      'BaileysSidecarUrl',
      Match.objectLike({
        Export: Match.objectLike({ Name: 'KosBaileysSidecarUrl' }),
      }),
    );
  });

  it('does NOT synthesise the sidecar when enableBaileysSidecar is unset', () => {
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
      blobsBucket: data.blobsBucket,
      // enableBaileysSidecar intentionally omitted
    });
    const tpl = Template.fromStack(integrations);
    const fns = tpl.findResources('AWS::Lambda::Function');
    const sidecar = Object.values(fns).find((f) => {
      const e = (
        f as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      ).Properties?.Environment?.Variables;
      return e !== undefined && 'BAILEYS_WEBHOOK_SECRET_ARN' in e;
    });
    expect(sidecar).toBeUndefined();
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const baileysSecrets = Object.values(secrets).filter((s) => {
      const name = (s as { Properties?: { Name?: string } }).Properties?.Name;
      return name === 'kos/baileys-webhook-secret';
    });
    expect(baileysSecrets).toHaveLength(0);
    expect(tpl.findOutputs('BaileysSidecarUrl')).toEqual({});
  });
});
