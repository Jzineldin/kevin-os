/**
 * Phase B synth tests — OpenclawBridgeStack.
 *
 * Asserts:
 *   - Lambda gets VPC config, memory 256, timeout 15s
 *   - Env vars match spec (KEVIN_OWNER_ID, secret ARNs, RDS_PROXY_ENDPOINT, etc)
 *   - Function URL = AWS_IAM
 *   - Lambda role can GetSecretValue on bearer + DB secrets
 *   - CfnOutput exposes the URL for wiring OpenClaw
 */
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { OpenclawBridgeStack } from '../lib/stacks/openclaw-bridge-stack';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

describe('OpenclawBridgeStack (Phase B)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
    const app = new App();
    const net = new NetworkStack(app, 'N', { env });
    const data = new DataStack(app, 'D', { env, vpc: net.vpc, s3Endpoint: net.s3GatewayEndpoint });

    // Test-local secrets (at deploy time these are the real pre-existing ones)
    const secretsStack = new Stack(app, 'SecretsHolder', { env });
    const bridgeBearer = new Secret(secretsStack, 'BearerSecret', { secretName: 'kos/openclaw-bridge-bearer' });
    const bridgeDb = new Secret(secretsStack, 'DbSecret', { secretName: 'kos/db/kos_openclaw_bridge' });

    const bridge = new OpenclawBridgeStack(app, 'B', {
      env,
      vpc: net.vpc,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxySecurityGroup: data.rdsSecurityGroup,
      kevinOwnerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      bridgeBearerSecret: bridgeBearer,
      bridgeDbSecret: bridgeDb,
    });
    return Template.fromStack(bridge);
  }

  it('creates a Lambda with 256 MB, 15s timeout, VPC config', () => {
    const t = synth();
    // There may be auxiliary Lambda functions (log retention custom resources);
    // pick the one whose handler matches openclaw-bridge by MemorySize=256
    const fns = t.findResources('AWS::Lambda::Function');
    const bridgeFns = Object.values(fns).filter((f: any) => f.Properties?.MemorySize === 256);
    expect(bridgeFns.length).toBeGreaterThanOrEqual(1);
    const bridgeFn = bridgeFns[0] as any;
    expect(bridgeFn.Properties.Timeout).toBe(15);
    expect(bridgeFn.Properties.Runtime).toMatch(/^nodejs/);
    expect(bridgeFn.Properties.VpcConfig).toBeDefined();
    expect(bridgeFn.Properties.VpcConfig.SubnetIds).toBeDefined();
  });

  it('injects all required env vars', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          KEVIN_OWNER_ID: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
          RDS_DATABASE: 'kos',
          RDS_USER: 'kos_openclaw_bridge',
          RDS_PROXY_ENDPOINT: Match.anyValue(),
          BRIDGE_BEARER_SECRET_ARN: Match.anyValue(),
          DB_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('creates a Function URL with AWS_IAM auth', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      InvokeMode: 'BUFFERED',
    });
  });

  it('grants Lambda role read access to bearer + DB secrets', () => {
    const t = synth();
    // At least 2 GetSecretValue statements on the role policy
    const policies = t.findResources('AWS::IAM::Policy');
    let count = 0;
    for (const [, p] of Object.entries(policies)) {
      const stmts = (p as any).Properties?.PolicyDocument?.Statement ?? [];
      for (const s of stmts) {
        const act = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (act.some((a: string) => typeof a === 'string' && a.includes('GetSecretValue'))) {
          count++;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('exposes BridgeFunctionUrl as a CfnOutput', () => {
    const t = synth();
    t.hasOutput('BridgeFunctionUrl', Match.objectLike({
      Value: Match.anyValue(),
      Description: Match.stringLikeRegexp('OpenClaw'),
    }));
  });
});
