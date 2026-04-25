/**
 * Plan 06-04 synth-level assertions for the entity-timeline-refresher
 * pipeline.
 *
 * Asserts:
 *   - CfnSchedule resource named 'entity-timeline-refresher-5min' exists.
 *   - ScheduleExpression === 'rate(5 minutes)' + Europe/Stockholm + OFF.
 *   - Lambda role has rds-db:connect (RDS Proxy IAM auth).
 *   - Lambda role does NOT have bedrock:InvokeModel (refresher is LLM-free).
 *   - Lambda timeout = 30 s; memory = 256 MB.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — MV refresher (Plan 06-04)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
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
      // kevinOwnerId enables wireGranolaPipeline + wireAzureSearchIndexers
      // + wireMvRefresher.
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('synthesises a Scheduler::Schedule named entity-timeline-refresher-5min', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'entity-timeline-refresher-5min',
      }),
    );
  });

  it('refresher schedule uses rate(5 minutes) + Europe/Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'entity-timeline-refresher-5min',
        ScheduleExpression: 'rate(5 minutes)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
      }),
    );
  });

  it('EntityTimelineRefresher Lambda is nodejs22.x + arm64; timeout 30 s; memory 256 MB', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const refresher = Object.entries(lambdas).find(([logicalId]) =>
      /^EntityTimelineRefresher/.test(logicalId),
    );
    expect(refresher).toBeDefined();
    const props = (refresher![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Timeout).toBe(30);
    expect(props.MemorySize).toBe(256);
  });

  it('EntityTimelineRefresher env carries RDS_PROXY_ENDPOINT + DATABASE_HOST + DATABASE_USER', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const refresher = Object.entries(lambdas).find(([logicalId]) =>
      /^EntityTimelineRefresher/.test(logicalId),
    );
    expect(refresher).toBeDefined();
    const env =
      ((refresher![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('RDS_PROXY_ENDPOINT');
    expect(env).toHaveProperty('DATABASE_HOST');
    expect(env).toHaveProperty('DATABASE_USER');
  });

  it('EntityTimelineRefresher role has rds-db:connect on the RDS Proxy DBI', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const refresherPolicies = Object.entries(policies).filter(([logicalId]) =>
      /EntityTimelineRefresher.*ServiceRoleDefaultPolicy|EntityTimelineRefresher.*Policy/i.test(
        logicalId,
      ),
    );
    expect(refresherPolicies.length).toBeGreaterThanOrEqual(1);
    const docs = refresherPolicies.map(
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
    expect(hasRdsConnect).toBe(true);
  });

  it('EntityTimelineRefresher role has NO bedrock:InvokeModel (refresher is LLM-free)', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const refresherPolicies = Object.entries(policies).filter(([logicalId]) =>
      /EntityTimelineRefresher/.test(logicalId),
    );
    const docs = refresherPolicies.map(
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
});
