/**
 * Phase 7 Plan 07-00 — synth-level assertions for the lifecycle automation
 * helper. Asserts the four-Lambda + two-role surface returned by
 * `wireLifecycleAutomation` lands in IntegrationsStack when SafetyStack
 * refs (cap table + alarmTopic) and outputBus are supplied.
 *
 * Schedules + IAM grants are deliberately NOT yet wired in 07-00; those
 * accrete in 07-01..07-04. Tests here verify the scaffold surface only.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { SafetyStack } from '../lib/stacks/safety-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — lifecycle automation (Plan 07-00)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
    const app = new App();
    const net = new NetworkStack(app, 'N', { env });
    const eventsStack = new EventsStack(app, 'E', { env });
    const data = new DataStack(app, 'D', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const safety = new SafetyStack(app, 'S', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      telegramBotTokenSecret: data.telegramBotTokenSecret,
      outputBus: eventsStack.buses.output,
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
      captureBus: eventsStack.buses.capture,
      systemBus: eventsStack.buses.system,
      agentBus: eventsStack.buses.agent,
      scheduleGroupName: eventsStack.scheduleGroupName,
      // Phase 7 wiring — passing all three activates wireLifecycleAutomation.
      telegramCapTable: safety.capTable,
      alarmTopic: safety.alarmTopic,
      outputBus: eventsStack.buses.output,
    });
    return { tpl: Template.fromStack(integrations), integrations };
  }

  it('wireLifecycleAutomation returns 4 brief Lambdas + 2 scheduler roles', () => {
    const { integrations } = synth();
    expect(integrations.lifecycle).toBeDefined();
    expect(integrations.lifecycle?.morningBrief).toBeDefined();
    expect(integrations.lifecycle?.dayClose).toBeDefined();
    expect(integrations.lifecycle?.weeklyReview).toBeDefined();
    expect(integrations.lifecycle?.verifyNotificationCap).toBeDefined();
    expect(integrations.lifecycle?.schedulerRole).toBeDefined();
    expect(integrations.lifecycle?.emailTriageSchedulerRole).toBeDefined();
  });

  it('MorningBrief Lambda: memory 1024 MB + timeout 600 s + nodejs22.x', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const morning = Object.entries(lambdas).find(([logicalId]) =>
      /^MorningBrief/.test(logicalId),
    );
    expect(morning).toBeDefined();
    const props = (morning![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.MemorySize).toBe(1024);
    expect(props.Timeout).toBe(600);
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
  });

  it('WeeklyReview Lambda: memory 1536 MB (larger than morning/day-close)', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const weekly = Object.entries(lambdas).find(([logicalId]) =>
      /^WeeklyReview/.test(logicalId),
    );
    expect(weekly).toBeDefined();
    const props = (weekly![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.MemorySize).toBe(1536);
    expect(props.Timeout).toBe(600);
  });

  it('VerifyNotificationCap Lambda env carries CAP_TABLE_NAME + ALARM_TOPIC_ARN', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const verify = Object.entries(lambdas).find(([logicalId]) =>
      /^VerifyNotificationCap/.test(logicalId),
    );
    expect(verify).toBeDefined();
    const env =
      ((verify![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('CAP_TABLE_NAME');
    expect(env).toHaveProperty('ALARM_TOPIC_ARN');
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
    expect(env).toHaveProperty('OUTPUT_BUS_NAME');
    expect(env).toHaveProperty('SYSTEM_BUS_NAME');

    // Memory + timeout per D-11.
    const props = (verify![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.MemorySize).toBe(512);
    expect(props.Timeout).toBe(180);
  });

  it('IntegrationsStack synthesises with NO Phase 7 Lambdas when SafetyStack refs are unset', () => {
    // Regression: existing test fixtures (mv-refresher, granola, etc.) must
    // continue to synth without the new SafetyStack/outputBus props.
    const app = new App();
    const net = new NetworkStack(app, 'N2', { env });
    const eventsStack = new EventsStack(app, 'E2', { env });
    const data = new DataStack(app, 'D2', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const integrations = new IntegrationsStack(app, 'I2', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      captureBus: eventsStack.buses.capture,
      systemBus: eventsStack.buses.system,
      scheduleGroupName: eventsStack.scheduleGroupName,
      // No SafetyStack refs / no outputBus — wireLifecycleAutomation skipped.
    });
    expect(integrations.lifecycle).toBeUndefined();
    const tpl = Template.fromStack(integrations);
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const lifecycleLambdas = Object.keys(lambdas).filter((k) =>
      /^(MorningBrief|DayClose|WeeklyReview|VerifyNotificationCap)/.test(k),
    );
    expect(lifecycleLambdas.length).toBe(0);
  });
});
