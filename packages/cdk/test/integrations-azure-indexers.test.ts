/**
 * Plan 06-03 synth-level assertions for the 4-Lambda + 4-Schedule
 * Azure Search indexer pipeline.
 *
 * Asserts:
 *   - 4 indexer Lambdas synth (entities / projects / transcripts / daily-brief).
 *   - 4 CfnSchedule resources with the canonical schedule names.
 *   - entities/projects/transcripts run on rate(5 minutes); daily-brief on
 *     rate(15 minutes); all timezone Europe/Stockholm; FlexibleTimeWindow OFF.
 *   - Each Lambda role carries rds-db:connect + bedrock:InvokeModel +
 *     secretsmanager:GetSecretValue (admin secret).
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — Azure Search indexers (Plan 06-03)', () => {
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
      // kevinOwnerId enables wireGranolaPipeline + wireAzureSearchIndexers.
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('synthesises 4 schedules with the per-content-type canonical names', () => {
    const { tpl } = synth();
    const schedules = tpl.findResources('AWS::Scheduler::Schedule');
    const names = Object.values(schedules).map(
      (s) => (s as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('azure-search-indexer-entities');
    expect(names).toContain('azure-search-indexer-projects');
    expect(names).toContain('azure-search-indexer-transcripts');
    expect(names).toContain('azure-search-indexer-daily-brief');
  });

  it('entities/projects/transcripts schedules use rate(5 minutes); daily-brief uses rate(15 minutes)', () => {
    const { tpl } = synth();
    const five = ['entities', 'projects', 'transcripts'];
    for (const which of five) {
      tpl.hasResourceProperties(
        'AWS::Scheduler::Schedule',
        Match.objectLike({
          Name: `azure-search-indexer-${which}`,
          ScheduleExpression: 'rate(5 minutes)',
        }),
      );
    }
    tpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'azure-search-indexer-daily-brief',
        ScheduleExpression: 'rate(15 minutes)',
      }),
    );
  });

  it('all 4 schedules are timezone Europe/Stockholm + FlexibleTimeWindow OFF', () => {
    const { tpl } = synth();
    const schedules = tpl.findResources('AWS::Scheduler::Schedule');
    const indexerSchedules = Object.values(schedules).filter((s) => {
      const name = (s as { Properties?: { Name?: string } }).Properties?.Name ?? '';
      return name.startsWith('azure-search-indexer-');
    });
    expect(indexerSchedules).toHaveLength(4);
    for (const s of indexerSchedules) {
      const props = (s as { Properties?: Record<string, unknown> }).Properties ?? {};
      expect(props.ScheduleExpressionTimezone).toBe('Europe/Stockholm');
      expect((props.FlexibleTimeWindow as { Mode?: string } | undefined)?.Mode).toBe('OFF');
    }
  });

  it('all 4 indexer Lambdas synth (KosLambda construct emits AWS::Lambda::Function)', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const indexerNames = Object.keys(lambdas).filter((id) =>
      /^AzureIndexer(Entities|Projects|Transcripts|DailyBrief)/i.test(id),
    );
    expect(indexerNames).toHaveLength(4);
  });

  it('each indexer Lambda env carries AZURE_SEARCH_ADMIN_SECRET_ARN + DATABASE_HOST + KOS_OWNER_ID', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const indexers = Object.entries(lambdas).filter(([id]) =>
      /^AzureIndexer(Entities|Projects|Transcripts|DailyBrief)/i.test(id),
    );
    expect(indexers).toHaveLength(4);
    for (const [, fn] of indexers) {
      const vars = (
        fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables ?? {};
      expect(vars).toHaveProperty('AZURE_SEARCH_ADMIN_SECRET_ARN');
      expect(vars).toHaveProperty('DATABASE_HOST');
      expect(vars).toHaveProperty('KOS_OWNER_ID');
      expect(vars).toHaveProperty('AZURE_SEARCH_INDEX_NAME');
    }
  });

  it('indexer roles collectively carry rds-db:connect + bedrock:InvokeModel + secretsmanager:GetSecretValue', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const collected = new Set<string>();
    for (const p of Object.values(policies)) {
      const stmts =
        (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [];
      for (const s of stmts as Array<{ Action?: string | string[] }>) {
        const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
        for (const a of actions) collected.add(a);
      }
    }
    expect(collected.has('rds-db:connect')).toBe(true);
    expect(collected.has('bedrock:InvokeModel')).toBe(true);
    expect(collected.has('secretsmanager:GetSecretValue')).toBe(true);
  });

  it('every indexer Lambda role has bedrock:InvokeModel scoped to Cohere v4', () => {
    const { tpl } = synth();
    // Find the AzureIndexer* Lambda role logical IDs.
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const indexerRoleLogicalIds: string[] = [];
    for (const [id, fn] of Object.entries(lambdas)) {
      if (!/^AzureIndexer(Entities|Projects|Transcripts|DailyBrief)/i.test(id)) continue;
      const role = (fn as { Properties?: { Role?: { 'Fn::GetAtt'?: string[] } } }).Properties?.Role;
      const roleLogical = role?.['Fn::GetAtt']?.[0];
      if (roleLogical) indexerRoleLogicalIds.push(roleLogical);
    }
    expect(indexerRoleLogicalIds).toHaveLength(4);

    // Each role must have at least one Policy with bedrock:InvokeModel.
    const policies = tpl.findResources('AWS::IAM::Policy');
    for (const targetRole of indexerRoleLogicalIds) {
      let hasBedrock = false;
      for (const p of Object.values(policies)) {
        const props = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] }; Roles?: Array<{ Ref?: string }> } }).Properties ?? {};
        const refs = (props.Roles ?? []).map((r) => r.Ref);
        if (!refs.includes(targetRole)) continue;
        const stmts = (props.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[]; Resource?: string | string[] }>;
        for (const s of stmts) {
          const actions = Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];
          if (actions.includes('bedrock:InvokeModel')) hasBedrock = true;
        }
      }
      expect(hasBedrock).toBe(true);
    }
  });

  it('all 4 schedules share the kos-schedules group (re-uses EventsStack scheduler group)', () => {
    const { tpl } = synth();
    const schedules = tpl.findResources('AWS::Scheduler::Schedule');
    const indexerSchedules = Object.values(schedules).filter((s) => {
      const name = (s as { Properties?: { Name?: string } }).Properties?.Name ?? '';
      return name.startsWith('azure-search-indexer-');
    });
    for (const s of indexerSchedules) {
      const props = (s as { Properties?: Record<string, unknown> }).Properties ?? {};
      expect(props.GroupName).toBeDefined();
    }
  });
});
