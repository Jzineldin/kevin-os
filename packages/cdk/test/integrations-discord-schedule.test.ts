/**
 * Plan 05-06 synth-level assertions for the Discord brain-dump Scheduler.
 *
 * Phase 5 owns the EventBridge Scheduler + IAM role; Phase 10 Plan 10-04
 * ships the Lambda handler. These tests assert the Scheduler contract is
 * stable (name, expression, timezone, input payload) so Phase 10 can
 * implement against a fixed surface.
 *
 * Asserts (5):
 *   - Scheduler resource named 'kos-discord-poll' exists.
 *   - scheduleExpression === 'cron(0/5 * * * ? *)'.
 *   - scheduleExpressionTimezone === 'UTC'.
 *   - Target Input JSON contains `channel: 'brain-dump'`.
 *   - Scheduler role has lambda:InvokeFunction permission.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — Discord brain-dump Scheduler (Plan 05-06)', () => {
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
      // kevinOwnerId enables wireDiscordSchedule.
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('creates a Scheduler::Schedule named kos-discord-poll', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'kos-discord-poll',
      }),
    );
  });

  it('discord schedule uses cron(0/5 * * * ? *) every 5 minutes', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'kos-discord-poll',
        ScheduleExpression: 'cron(0/5 * * * ? *)',
      }),
    );
  });

  it('discord schedule timezone is UTC + FlexibleTimeWindow OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'kos-discord-poll',
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
      }),
    );
  });

  it('discord schedule target Input JSON declares channel=brain-dump', () => {
    const { tpl } = synth();
    const schedules = tpl.findResources('AWS::Scheduler::Schedule');
    const discord = Object.entries(schedules).find(
      ([, r]) =>
        ((r as { Properties?: { Name?: string } }).Properties?.Name) === 'kos-discord-poll',
    );
    expect(discord).toBeDefined();
    const target = ((discord![1] as {
      Properties: { Target: { Input?: string } };
    }).Properties.Target);
    expect(target.Input).toBeDefined();
    const parsed = JSON.parse(target.Input!) as Record<string, unknown>;
    expect(parsed.channel).toBe('brain-dump');
    expect(parsed.trigger_source).toBe('kos-discord-poll-scheduler');
    expect(parsed.owner_id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('discord scheduler role has lambda:InvokeFunction permission', () => {
    const { tpl } = synth();
    // Locate the role used by the kos-discord-poll schedule, then walk
    // the IAM::Policy resources attached to that role and assert at least
    // one statement carries lambda:InvokeFunction.
    const roles = tpl.findResources('AWS::IAM::Role');
    const discordRoleEntry = Object.entries(roles).find(([logicalId]) =>
      /^DiscordScheduleRole/i.test(logicalId),
    );
    expect(discordRoleEntry).toBeDefined();
    const discordRoleLogicalId = discordRoleEntry![0];

    const policies = tpl.findResources('AWS::IAM::Policy');
    let invokePresent = false;
    for (const p of Object.values(policies)) {
      const props = (p as {
        Properties?: {
          PolicyDocument?: { Statement?: unknown[] };
          Roles?: Array<{ Ref?: string }>;
        };
      }).Properties ?? {};
      const refs = (props.Roles ?? []).map((r) => r.Ref);
      if (!refs.includes(discordRoleLogicalId)) continue;
      const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{
        Action?: string | string[];
      }>;
      for (const s of stmts) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        if (actions.includes('lambda:InvokeFunction')) invokePresent = true;
      }
    }
    expect(invokePresent).toBe(true);
  });
});
