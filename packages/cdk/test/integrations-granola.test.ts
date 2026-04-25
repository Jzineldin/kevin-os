/**
 * Plan 06-01 synth-level assertions for the Granola pipeline wiring.
 *
 * Asserts:
 *   - CfnSchedule resource named 'granola-poller-1min' exists.
 *   - ScheduleExpression === 'rate(1 minute)' + Europe/Stockholm + OFF.
 *   - Lambda role has rds-db:connect (for RDS Proxy IAM auth).
 *   - Lambda role has events:PutEvents (for kos.capture publish).
 *   - Lambda role has secretsmanager:GetSecretValue (for NOTION_TOKEN).
 *   - Lambda role does NOT have bedrock:InvokeModel (poller is LLM-free).
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — Granola pipeline (Plan 06-01)', () => {
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
      // Phase 6 Plan 06-01: enables wireGranolaPipeline.
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('creates a Scheduler::Schedule named granola-poller-1min', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'granola-poller-1min',
      }),
    );
  });

  it('granola schedule uses rate(1 minute) + Europe/Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'granola-poller-1min',
        ScheduleExpression: 'rate(1 minute)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
      }),
    );
  });

  it('granola-poller Lambda uses nodejs22.x + arm64', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const granola = Object.entries(lambdas).find(([logicalId]) =>
      /^GranolaPoller/i.test(logicalId),
    );
    expect(granola).toBeDefined();
    const props = (granola![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
  });

  it('granola-poller env carries KEVIN_OWNER_ID + KOS_CAPTURE_BUS_NAME + RDS_PROXY_ENDPOINT + NOTION_TOKEN_SECRET_ARN', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const granola = Object.entries(lambdas).find(([logicalId]) =>
      /^GranolaPoller/i.test(logicalId),
    );
    expect(granola).toBeDefined();
    const env =
      ((granola![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
    expect(env).toHaveProperty('KOS_CAPTURE_BUS_NAME');
    expect(env).toHaveProperty('RDS_PROXY_ENDPOINT');
    expect(env).toHaveProperty('NOTION_TOKEN_SECRET_ARN');
  });

  it('granola-poller IAM has rds-db:connect + events:PutEvents + secretsmanager:GetSecretValue', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const collected = new Set<string>();
    for (const p of Object.values(policies)) {
      const stmts = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
        .Properties?.PolicyDocument?.Statement ?? [];
      for (const s of stmts as Array<{ Action?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) collected.add(a);
      }
    }
    expect(collected.has('rds-db:connect')).toBe(true);
    expect(collected.has('events:PutEvents')).toBe(true);
    // grantRead on Secrets Manager fans out to GetSecretValue (and DescribeSecret).
    expect(collected.has('secretsmanager:GetSecretValue')).toBe(true);
  });

  it('granola-poller IAM does NOT carry bedrock:InvokeModel (poller is LLM-free)', () => {
    const { tpl } = synth();
    // Find policies attached to the GranolaPoller Lambda's role only.
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const granolaEntry = Object.entries(lambdas).find(([logicalId]) =>
      /^GranolaPoller/i.test(logicalId),
    );
    expect(granolaEntry).toBeDefined();
    const granolaProps = (granolaEntry![1] as { Properties: { Role?: { 'Fn::GetAtt'?: string[] } } })
      .Properties;
    const granolaRoleLogicalId = granolaProps.Role?.['Fn::GetAtt']?.[0];
    expect(granolaRoleLogicalId).toBeDefined();

    const policies = tpl.findResources('AWS::IAM::Policy');
    let bedrockOnGranola = false;
    for (const p of Object.values(policies)) {
      const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(granolaRoleLogicalId!)) continue;
      const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[] }>;
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        if (actions.some((a) => a.startsWith('bedrock:'))) bedrockOnGranola = true;
      }
    }
    expect(bedrockOnGranola).toBe(false);
  });
});
