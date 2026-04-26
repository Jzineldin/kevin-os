/**
 * Plan 04-02 synth-level assertions for the ses-inbound (CAP-03) pipeline.
 *
 * Asserts:
 *   - SesInbound Lambda synths with timeout 30 s + memory 512 MB + nodejs22.x.
 *   - Role has `s3:GetObject` on the kos-ses-inbound-euw1 bucket's `incoming/` prefix.
 *   - Role has `events:PutEvents` on the kos.capture bus.
 *   - Lambda::Permission for ses.amazonaws.com with SourceAccount condition.
 *   - Role has NO `rds-db:connect` (D-05: outside VPC, no RDS).
 *   - Role has NO `bedrock:*` (no LLM call here — classification is downstream).
 *   - Role has NO `ses:SendRawEmail` (no outbound mail).
 *   - When `enableSesInbound` is false / unset → no ses-inbound Lambda synthesises
 *     (fixture symmetry — existing tests must continue to compose without the flag).
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

const env = { account: '123456789012', region: 'eu-north-1' };

function synth(opts: { enableSesInbound: boolean }) {
  const app = new App();
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const integrations = new IntegrationsStack(app, 'I', {
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
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
    sentryDsnSecret: data.sentryDsnSecret,
    langfusePublicKeySecret: data.langfusePublicSecret,
    langfuseSecretKeySecret: data.langfuseSecretSecret,
    enableSesInbound: opts.enableSesInbound,
  });
  return { tpl: Template.fromStack(integrations), stack: integrations };
}

describe('IntegrationsStack — ses-inbound (Plan 04-02)', () => {
  it('synthesises a SesInbound Lambda when enableSesInbound=true', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const sesInbound = Object.entries(lambdas).find(([logicalId]) =>
      /^SesInbound/.test(logicalId),
    );
    expect(sesInbound).toBeDefined();
    const props = (sesInbound![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Timeout).toBe(30);
    expect(props.MemorySize).toBe(512);
  });

  it('does NOT synthesise a SesInbound Lambda when enableSesInbound is unset', () => {
    const { tpl } = synth({ enableSesInbound: false });
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const sesInbound = Object.entries(lambdas).find(([logicalId]) =>
      /^SesInbound/.test(logicalId),
    );
    expect(sesInbound).toBeUndefined();
  });

  it('SesInbound Lambda env carries SES_INBOUND_BUCKET_NAME + KEVIN_OWNER_ID', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const sesInbound = Object.entries(lambdas).find(([logicalId]) =>
      /^SesInbound/.test(logicalId),
    );
    expect(sesInbound).toBeDefined();
    const env =
      ((sesInbound![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('SES_INBOUND_BUCKET_NAME');
    expect(env.SES_INBOUND_BUCKET_NAME).toBe('kos-ses-inbound-euw1');
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
  });

  it('SesInbound role has s3:GetObject on kos-ses-inbound-euw1-*/incoming/*', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicies = Object.entries(policies).filter(([logicalId]) =>
      /SesInbound.*ServiceRoleDefaultPolicy|SesInbound.*Policy/i.test(logicalId),
    );
    expect(sesPolicies.length).toBeGreaterThanOrEqual(1);
    const docs = sesPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown; Resource?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasGetObject = flat.some((s) => {
      const action = s.Action;
      const actionList = typeof action === 'string' ? [action] : Array.isArray(action) ? action : [];
      const resource = s.Resource;
      const resourceList = typeof resource === 'string' ? [resource] : Array.isArray(resource) ? resource : [];
      return (
        actionList.includes('s3:GetObject') &&
        resourceList.some((r) => typeof r === 'string' && r.includes('kos-ses-inbound-euw1-') && r.includes('/incoming/'))
      );
    });
    expect(hasGetObject).toBe(true);
  });

  it('SesInbound role has events:PutEvents on the kos.capture bus', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicies = Object.entries(policies).filter(([logicalId]) =>
      /SesInbound/.test(logicalId),
    );
    const docs = sesPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasPutEvents = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return action === 'events:PutEvents';
      if (Array.isArray(action)) return action.includes('events:PutEvents');
      return false;
    });
    expect(hasPutEvents).toBe(true);
  });

  it('SesInbound has Lambda::Permission for ses.amazonaws.com with SourceAccount', () => {
    const { tpl } = synth({ enableSesInbound: true });
    tpl.hasResourceProperties(
      'AWS::Lambda::Permission',
      Match.objectLike({
        Action: 'lambda:InvokeFunction',
        Principal: 'ses.amazonaws.com',
        SourceAccount: '123456789012',
      }),
    );
  });

  it('SesInbound role has NO rds-db:connect (D-05: outside VPC)', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicies = Object.entries(policies).filter(([logicalId]) =>
      /SesInbound/.test(logicalId),
    );
    const docs = sesPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasRdsConnect = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return action === 'rds-db:connect';
      if (Array.isArray(action)) return action.includes('rds-db:connect');
      return false;
    });
    expect(hasRdsConnect).toBe(false);
  });

  it('SesInbound role has NO bedrock:* (no LLM call — triage is downstream)', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicies = Object.entries(policies).filter(([logicalId]) =>
      /SesInbound/.test(logicalId),
    );
    const docs = sesPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasBedrock = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return /bedrock:/i.test(action);
      if (Array.isArray(action)) return action.some((a) => /bedrock:/i.test(String(a)));
      return false;
    });
    expect(hasBedrock).toBe(false);
  });

  it('SesInbound role has NO ses:SendRawEmail (no outbound mail)', () => {
    const { tpl } = synth({ enableSesInbound: true });
    const policies = tpl.findResources('AWS::IAM::Policy');
    const sesPolicies = Object.entries(policies).filter(([logicalId]) =>
      /SesInbound/.test(logicalId),
    );
    const docs = sesPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasSesSend = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return /ses:Send/i.test(action);
      if (Array.isArray(action)) return action.some((a) => /ses:Send/i.test(String(a)));
      return false;
    });
    expect(hasSesSend).toBe(false);
  });
});
