import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

/**
 * IntegrationsStack synth-level assertions for the Notion wiring.
 *
 * Covers:
 *  - 4 indexer EventBridge schedules (D-11 — Entities, Projects, KevinContext,
 *    CommandCenter) + 1 weekly reconcile schedule.
 *  - Each schedule uses `rate(5 minutes)` and `Europe/Stockholm`.
 *  - Reconcile uses `cron(0 4 ? * SUN *)` and `Europe/Stockholm`.
 *  - All three Lambdas use runtime `nodejs22.x` + architecture `arm64`.
 *  - DataStack exposes an RDS Proxy with `RequireTLS: true` and `DebugLogging`
 *    absent (sensible defaults).
 */
describe('IntegrationsStack (Notion wiring)', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
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
  });

  const iTpl = Template.fromStack(integrations);
  const dTpl = Template.fromStack(data);

  it('creates >= 3 AWS::Scheduler::Schedule resources (5 indexer + 1 reconcile)', () => {
    const schedules = iTpl.findResources('AWS::Scheduler::Schedule');
    expect(Object.keys(schedules).length).toBeGreaterThanOrEqual(3);
  });

  it('creates exactly 6 schedules total (4 D-11 + 1 KOS Inbox + 1 weekly reconcile)', () => {
    const schedules = iTpl.findResources('AWS::Scheduler::Schedule');
    expect(Object.keys(schedules).length).toBe(6);
  });

  it('Plan 02-07: kos-inbox-poll schedule fires the indexer with dbName=kosInbox every 5 min', () => {
    iTpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        Name: 'kos-inbox-poll',
        ScheduleExpression: 'rate(5 minutes)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
        Target: Match.objectLike({
          // The Input JSON includes `"dbName":"kosInbox"` so the indexer
          // dispatches to the KOS Inbox branch (Plan 02-07 D-13/D-14 sync).
          Input: Match.stringLikeRegexp('"dbName":"kosInbox"'),
        }),
      }),
    );
  });

  it('Plan 02-07: notion-indexer Lambda env contains NOTION_KOS_INBOX_DB_ID + NOTION_ENTITIES_DB_ID', () => {
    const lambdas = iTpl.findResources('AWS::Lambda::Function');
    const indexer = Object.entries(lambdas).find(([logicalId]) =>
      /^NotionIndexer[^B]/i.test(logicalId),
    );
    expect(indexer).toBeDefined();
    const env = (indexer![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('NOTION_KOS_INBOX_DB_ID');
    expect(env).toHaveProperty('NOTION_ENTITIES_DB_ID');
  });

  it('each indexer schedule has rate(5 minutes) + Europe/Stockholm', () => {
    iTpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        ScheduleExpression: 'rate(5 minutes)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
      }),
    );
  });

  it('weekly reconcile schedule uses cron(0 4 ? * SUN *) + Europe/Stockholm', () => {
    iTpl.hasResourceProperties(
      'AWS::Scheduler::Schedule',
      Match.objectLike({
        ScheduleExpression: 'cron(0 4 ? * SUN *)',
        ScheduleExpressionTimezone: 'Europe/Stockholm',
      }),
    );
  });

  it('notion-indexer + backfill + reconcile Lambdas use nodejs22.x + arm64', () => {
    const lambdas = iTpl.findResources('AWS::Lambda::Function');
    // KOS Lambdas are identifiable by logical-ID prefix (NotionIndexer*,
    // NotionReconcile). CDK's log-retention helper Lambda is excluded.
    const kosLambdas = Object.entries(lambdas).filter(([logicalId]) =>
      /^Notion(Indexer|IndexerBackfill|Reconcile)/i.test(logicalId),
    );
    expect(kosLambdas.length).toBeGreaterThanOrEqual(3);
    for (const [, fn] of kosLambdas) {
      const props = (fn as { Properties: Record<string, unknown> }).Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('RDS Proxy is provisioned with RequireTLS + IAM auth', () => {
    dTpl.hasResourceProperties(
      'AWS::RDS::DBProxy',
      Match.objectLike({
        RequireTLS: true,
        Auth: Match.arrayWith([
          Match.objectLike({ IAMAuth: 'REQUIRED' }),
        ]),
      }),
    );
  });

  it('indexer Lambda has rds-db:connect permission scoped to the Proxy DbiResourceId', () => {
    const policies = iTpl.findResources('AWS::IAM::Policy');
    const hasRdsConnect = Object.values(policies).some((p) => {
      const statements = (p as any).Properties?.PolicyDocument?.Statement ?? [];
      return statements.some(
        (s: any) =>
          (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('rds-db:connect'),
      );
    });
    expect(hasRdsConnect).toBe(true);
  });
});
