/**
 * Plan 08-01 synth-level assertions for the calendar-reader pipeline.
 *
 * Asserts:
 *   - CfnSchedule resource named 'calendar-reader-30min' exists with the
 *     `cron(0/30 * * * ? *)` expression and Europe/Stockholm timezone.
 *   - CalendarReader Lambda uses nodejs22.x + arm64 + memory=512 + timeout=60.
 *   - Lambda env carries KEVIN_OWNER_ID + KOS_CAPTURE_BUS_NAME +
 *     RDS_PROXY_ENDPOINT.
 *   - IAM has rds-db:connect on kos_agent_writer + events:PutEvents on the
 *     kos.capture bus + secretsmanager:GetSecretValue (for both gcal secrets).
 *   - IAM does NOT carry bedrock:* / ses:* / postiz:* / notion:* — read-only
 *     by structural separation (T-08-CAL-06 mitigation).
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — calendar-reader (Plan 08-01)', () => {
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

  it('creates a Scheduler::Schedule named calendar-reader-30min', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({ Name: 'calendar-reader-30min' }),
    );
  });

  it('schedule uses cron(0/30) + Europe/Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'calendar-reader-30min',
        ScheduleExpression: 'cron(0/30 * * * ? *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
      }),
    );
  });

  it('CalendarReader Lambda uses nodejs22.x + arm64 + memory=512 + timeout=60', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const reader = Object.entries(lambdas).find(([logicalId]) =>
      /^CalendarReader/i.test(logicalId),
    );
    expect(reader).toBeDefined();
    const props = (reader![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.MemorySize).toBe(512);
    expect(props.Timeout).toBe(60);
  });

  it('CalendarReader env carries KEVIN_OWNER_ID + KOS_CAPTURE_BUS_NAME + RDS_PROXY_ENDPOINT', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const reader = Object.entries(lambdas).find(([logicalId]) =>
      /^CalendarReader/i.test(logicalId),
    );
    expect(reader).toBeDefined();
    const env =
      ((reader![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
    expect(env).toHaveProperty('KOS_CAPTURE_BUS_NAME');
    expect(env).toHaveProperty('RDS_PROXY_ENDPOINT');
    expect(env).toHaveProperty('GCAL_SECRET_ELZARKA_ARN');
    expect(env).toHaveProperty('GCAL_SECRET_TALEFORGE_ARN');
  });

  it('CalendarReader IAM has rds-db:connect + events:PutEvents + secretsmanager:GetSecretValue', () => {
    const { tpl } = synth();
    // Find the role attached to the CalendarReader Lambda.
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const readerEntry = Object.entries(lambdas).find(([logicalId]) =>
      /^CalendarReader/i.test(logicalId),
    );
    expect(readerEntry).toBeDefined();
    const readerProps = (readerEntry![1] as { Properties: { Role?: { 'Fn::GetAtt'?: string[] } } })
      .Properties;
    const readerRoleLogicalId = readerProps.Role?.['Fn::GetAtt']?.[0];
    expect(readerRoleLogicalId).toBeDefined();

    const policies = tpl.findResources('AWS::IAM::Policy');
    const collected = new Set<string>();
    for (const p of Object.values(policies)) {
      const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(readerRoleLogicalId!)) continue;
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

  it('CalendarReader IAM does NOT carry bedrock:* / ses:* / postiz:* / notion:* (read-only)', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const readerEntry = Object.entries(lambdas).find(([logicalId]) =>
      /^CalendarReader/i.test(logicalId),
    );
    expect(readerEntry).toBeDefined();
    const readerRoleLogicalId = ((readerEntry![1] as {
      Properties: { Role?: { 'Fn::GetAtt'?: string[] } };
    }).Properties.Role?.['Fn::GetAtt']?.[0])!;

    const policies = tpl.findResources('AWS::IAM::Policy');
    const forbidden = new Set<string>();
    for (const p of Object.values(policies)) {
      const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(readerRoleLogicalId)) continue;
      const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[] }>;
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) {
          if (
            a.startsWith('bedrock:') ||
            a.startsWith('ses:') ||
            a.startsWith('postiz:') ||
            // notion is not an AWS namespace; if anyone hand-rolls a custom
            // statement for it, this would catch it.
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
