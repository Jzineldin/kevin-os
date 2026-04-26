/**
 * Synth-level assertions for the gmail-poller pipeline (replaces EmailEngine).
 *
 * Asserts:
 *   - CfnSchedule resource named 'gmail-poller-5min' exists with the
 *     `cron(0/5 * * * ? *)` expression and Europe/Stockholm timezone.
 *   - GmailPoller Lambda uses nodejs22.x + arm64 + memory=512 + timeout=60.
 *   - Lambda env carries KEVIN_OWNER_ID + KOS_CAPTURE_BUS_NAME +
 *     RDS_PROXY_ENDPOINT + both gcal-oauth secret ARNs.
 *   - IAM has rds-db:connect on kos_agent_writer + events:PutEvents on the
 *     kos.capture bus + secretsmanager:GetSecretValue on the OAuth secrets.
 *   - IAM does NOT carry bedrock:* / ses:* / postiz:* / notion:* — read-only.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — gmail-poller', () => {
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
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('creates a Scheduler::Schedule named gmail-poller-5min', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({ Name: 'gmail-poller-5min' }),
    );
  });

  it('schedule uses cron(0/5) + Europe/Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'gmail-poller-5min',
        ScheduleExpression: 'cron(0/5 * * * ? *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
      }),
    );
  });

  it('GmailPoller Lambda uses nodejs22.x + arm64 + memory=512 + timeout=60', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const poller = Object.entries(lambdas).find(([logicalId]) =>
      /^GmailPoller/i.test(logicalId),
    );
    expect(poller).toBeDefined();
    const props = (poller![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.MemorySize).toBe(512);
    expect(props.Timeout).toBe(60);
  });

  it('GmailPoller env carries owner id, capture bus, RDS, both gcal secrets', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const poller = Object.entries(lambdas).find(([logicalId]) =>
      /^GmailPoller/i.test(logicalId),
    );
    expect(poller).toBeDefined();
    const env =
      ((poller![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
    expect(env).toHaveProperty('KOS_CAPTURE_BUS_NAME');
    expect(env).toHaveProperty('RDS_PROXY_ENDPOINT');
    expect(env).toHaveProperty('GCAL_SECRET_ELZARKA_ARN');
    expect(env).toHaveProperty('GCAL_SECRET_TALEFORGE_ARN');
  });

  it('GmailPoller IAM has rds-db:connect + events:PutEvents + secretsmanager:GetSecretValue', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const pollerEntry = Object.entries(lambdas).find(([logicalId]) =>
      /^GmailPoller/i.test(logicalId),
    );
    expect(pollerEntry).toBeDefined();
    const pollerRoleLogicalId = ((pollerEntry![1] as {
      Properties: { Role?: { 'Fn::GetAtt'?: string[] } };
    }).Properties.Role?.['Fn::GetAtt']?.[0])!;

    const policies = tpl.findResources('AWS::IAM::Policy');
    const collected = new Set<string>();
    for (const p of Object.values(policies)) {
      const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(pollerRoleLogicalId)) continue;
      const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[] }>;
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) collected.add(a);
      }
    }
    expect(collected.has('rds-db:connect')).toBe(true);
    expect(collected.has('events:PutEvents')).toBe(true);
    expect(collected.has('secretsmanager:GetSecretValue')).toBe(true);
  });

  it('GmailPoller IAM does NOT carry bedrock:* / ses:* / postiz:* / notion:* (read-only)', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const pollerEntry = Object.entries(lambdas).find(([logicalId]) =>
      /^GmailPoller/i.test(logicalId),
    );
    expect(pollerEntry).toBeDefined();
    const pollerRoleLogicalId = ((pollerEntry![1] as {
      Properties: { Role?: { 'Fn::GetAtt'?: string[] } };
    }).Properties.Role?.['Fn::GetAtt']?.[0])!;

    const policies = tpl.findResources('AWS::IAM::Policy');
    const forbidden = new Set<string>();
    for (const p of Object.values(policies)) {
      const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(pollerRoleLogicalId)) continue;
      const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[] }>;
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) {
          if (
            a.startsWith('bedrock:') ||
            a.startsWith('ses:') ||
            a.startsWith('postiz:') ||
            a.startsWith('notion:')
          ) {
            forbidden.add(a);
          }
        }
      }
    }
    expect(Array.from(forbidden)).toEqual([]);
  });
});
