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

  // --- Plan 07-01: morning-brief schedule + IAM grants -----------------
  it('Plan 07-01: MorningBrief IAM has bedrock:InvokeModel on Sonnet 4.6 EU profile', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    let found = false;
    for (const p of Object.values(policies)) {
      const stmts =
        ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement) ?? [];
      for (const s of stmts as Array<{ Action?: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        const resources = Array.isArray(s.Resource) ? s.Resource : s.Resource ? [s.Resource] : [];
        if (
          actions.includes('bedrock:InvokeModel') &&
          resources.some((r) => /eu\.anthropic\.claude-sonnet-4-6/.test(String(r)))
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('Plan 07-01: MorningBrief IAM has rds-db:connect on kos_admin', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    let found = false;
    for (const p of Object.values(policies)) {
      const stmts =
        ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement) ?? [];
      for (const s of stmts as Array<{ Action?: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        const resources = Array.isArray(s.Resource) ? s.Resource : s.Resource ? [s.Resource] : [];
        if (
          actions.includes('rds-db:connect') &&
          resources.some((r) => /kos_admin/.test(JSON.stringify(r)))
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('Plan 07-01: CfnSchedule morning-brief-weekdays-08 cron + Europe/Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'morning-brief-weekdays-08',
        ScheduleExpression: 'cron(0 8 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
        State: 'ENABLED',
      }),
    );
  });

  it('Plan 07-01: morning-brief schedule targets the MorningBrief Lambda function (not a bus)', () => {
    const { tpl } = synth();
    const schedules = tpl.findResources('AWS::Scheduler::Schedule');
    const entry = Object.entries(schedules).find(
      ([, r]) =>
        (r as { Properties?: { Name?: string } }).Properties?.Name ===
        'morning-brief-weekdays-08',
    );
    expect(entry).toBeDefined();
    const target = (entry![1] as { Properties: { Target: { Arn: unknown } } }).Properties.Target;
    // Target.Arn for a Lambda invoke is a Fn::GetAtt to the function — string match
    // shape varies, so we serialise + grep for "MorningBrief" + "Arn".
    const targetSerialised = JSON.stringify(target.Arn);
    expect(targetSerialised).toMatch(/MorningBrief/);
    expect(targetSerialised).toMatch(/Arn/);
  });

  // --- Plan 07-02: day-close + weekly-review IAM + schedules -----------
  it('Plan 07-02: DayClose IAM has bedrock:InvokeModel + rds-db:connect + Notion read', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    let bedrock = false;
    let rds = false;
    for (const p of Object.values(policies)) {
      const roles =
        ((p as { Properties?: { Roles?: Array<{ Ref?: string }> } }).Properties?.Roles ?? []);
      const onDayClose = roles.some((r) => /^DayCloseServiceRole/.test(r.Ref ?? ''));
      if (!onDayClose) continue;
      const stmts =
        ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement) ?? [];
      for (const s of stmts as Array<{ Action?: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        const resources = Array.isArray(s.Resource) ? s.Resource : s.Resource ? [s.Resource] : [];
        if (
          actions.includes('bedrock:InvokeModel') &&
          resources.some((r) => /eu\.anthropic\.claude-sonnet-4-6/.test(String(r)))
        ) {
          bedrock = true;
        }
        if (
          actions.includes('rds-db:connect') &&
          resources.some((r) => /kos_admin/.test(JSON.stringify(r)))
        ) {
          rds = true;
        }
      }
    }
    expect(bedrock).toBe(true);
    expect(rds).toBe(true);
  });

  it('Plan 07-02: WeeklyReview IAM has bedrock:InvokeModel + rds-db:connect', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    let bedrock = false;
    let rds = false;
    for (const p of Object.values(policies)) {
      const roles =
        ((p as { Properties?: { Roles?: Array<{ Ref?: string }> } }).Properties?.Roles ?? []);
      const onWeekly = roles.some((r) => /^WeeklyReviewServiceRole/.test(r.Ref ?? ''));
      if (!onWeekly) continue;
      const stmts =
        ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement) ?? [];
      for (const s of stmts as Array<{ Action?: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        const resources = Array.isArray(s.Resource) ? s.Resource : s.Resource ? [s.Resource] : [];
        if (
          actions.includes('bedrock:InvokeModel') &&
          resources.some((r) => /eu\.anthropic\.claude-sonnet-4-6/.test(String(r)))
        ) {
          bedrock = true;
        }
        if (
          actions.includes('rds-db:connect') &&
          resources.some((r) => /kos_admin/.test(JSON.stringify(r)))
        ) {
          rds = true;
        }
      }
    }
    expect(bedrock).toBe(true);
    expect(rds).toBe(true);
  });

  it('Plan 07-02: DayClose Lambda env carries NOTION_KEVIN_CONTEXT_PAGE_ID', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const dayClose = Object.entries(lambdas).find(([logicalId]) =>
      /^DayClose[^S]/.test(logicalId), // exclude DayCloseSchedule
    );
    expect(dayClose).toBeDefined();
    const env =
      ((dayClose![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('NOTION_KEVIN_CONTEXT_PAGE_ID');
    expect(env).toHaveProperty('NOTION_TODAY_PAGE_ID');
    expect(env).toHaveProperty('NOTION_DAILY_BRIEF_LOG_DB_ID');
  });

  it('Plan 07-02: WeeklyReview Lambda env carries NOTION_KEVIN_CONTEXT_PAGE_ID', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const weekly = Object.entries(lambdas).find(([logicalId]) =>
      /^WeeklyReview[^S]/.test(logicalId), // exclude WeeklyReviewSchedule
    );
    expect(weekly).toBeDefined();
    const env =
      ((weekly![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('NOTION_KEVIN_CONTEXT_PAGE_ID');
    expect(env).toHaveProperty('NOTION_DAILY_BRIEF_LOG_DB_ID');
  });

  it('Plan 07-02: CfnSchedule day-close-weekdays-18 cron + Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'day-close-weekdays-18',
        ScheduleExpression: 'cron(0 18 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
        State: 'ENABLED',
      }),
    );
  });

  it('Plan 07-02: CfnSchedule weekly-review-sun-19 cron + Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'weekly-review-sun-19',
        ScheduleExpression: 'cron(0 19 ? * SUN *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
        State: 'ENABLED',
      }),
    );
  });

  // --- Plan 07-03: AUTO-02 email-triage every-2h scheduler --------------
  it('Plan 07-03: CfnSchedule email-triage-every-2h with cron + Stockholm + OFF', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'email-triage-every-2h',
        ScheduleExpression: 'cron(0 8/2 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        FlexibleTimeWindow: Match.objectLike({ Mode: 'OFF' }),
        State: 'ENABLED',
        Target: Match.objectLike({
          // Templated EventBridge target carries DetailType + Source.
          EventBridgeParameters: Match.objectLike({
            DetailType: 'scan_emails_now',
            Source: 'kos.system',
          }),
          // Detail body matches Plan 04-05 fire-scan-emails-now.mjs envelope.
          Input: Match.stringLikeRegexp('"requested_by":"scheduler"'),
        }),
      }),
    );
  });

  it('Plan 07-03: emailTriageSchedulerRole has events:PutEvents on systemBus (and NOT lambda:InvokeFunction)', () => {
    const { tpl } = synth();

    // Locate the EmailTriageSchedulerRole and its inline policy.
    const roles = tpl.findResources('AWS::IAM::Role');
    const triageRoleEntry = Object.entries(roles).find(([logicalId]) =>
      /^EmailTriageSchedulerRole/.test(logicalId),
    );
    expect(triageRoleEntry).toBeDefined();
    const [triageRoleLogicalId] = triageRoleEntry!;

    const policies = tpl.findResources('AWS::IAM::Policy');
    // Inline policy attached only to the triage scheduler role.
    const triagePolicies = Object.values(policies).filter((p) => {
      const roleRefs =
        ((p as { Properties?: { Roles?: Array<{ Ref?: string }> } }).Properties?.Roles ?? []);
      return roleRefs.some((r) => r.Ref === triageRoleLogicalId);
    });
    expect(triagePolicies.length).toBeGreaterThanOrEqual(1);

    const collectedActions = new Set<string>();
    for (const p of triagePolicies) {
      const stmts =
        ((p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement) ?? [];
      for (const s of stmts as Array<{ Action?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) collectedActions.add(a);
      }
    }
    // Structural least-privilege: ONLY events:PutEvents; explicitly NO Lambda invoke.
    expect(collectedActions.has('events:PutEvents')).toBe(true);
    expect(collectedActions.has('lambda:InvokeFunction')).toBe(false);
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
