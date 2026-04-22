import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { SafetyStack } from '../lib/stacks/safety-stack';

/**
 * SafetyStack synth-level assertions (Plan 01-07).
 *
 * Covers:
 *  - DynamoDB cap table: PAY_PER_REQUEST, TTL `ttl` enabled, PK `pk` STRING
 *  - push-telegram Lambda: runtime nodejs22.x, arm64, outside VPC
 *  - SNS topic + EmailSubscription to kevin@tale-forge.app
 *  - AWS Budgets resource: COST / MONTHLY with 3 notifications (50 + 100
 *    actual, 100 forecasted)
 *  - SNS resource policy: Budgets principal scoped by aws:SourceArn
 */
describe('SafetyStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const safety = new SafetyStack(app, 'S', {
    env,
    rdsSecret: data.rdsCredentialsSecret,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    telegramBotTokenSecret: data.telegramBotTokenSecret,
  });
  const tpl = Template.fromStack(safety);

  it('creates a DynamoDB table with PAY_PER_REQUEST + TTL `ttl` + PK `pk` STRING', () => {
    tpl.hasResourceProperties(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: Match.arrayWith([
          Match.objectLike({ AttributeName: 'pk', AttributeType: 'S' }),
        ]),
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      }),
    );
  });

  it('retains the DynamoDB cap table on stack destroy', () => {
    tpl.hasResource(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      }),
    );
  });

  it('creates the push-telegram Lambda (nodejs22.x, arm64) outside the VPC', () => {
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        // No VpcConfig — push-telegram runs outside the VPC (D-05).
        VpcConfig: Match.absent(),
      }),
    );
  });

  it('wires CAP_TABLE_NAME + RDS_ENDPOINT + RDS_SECRET_ARN into the Lambda env', () => {
    // Find the lambda function and check env keys exist.
    const fns = tpl.findResources('AWS::Lambda::Function');
    const pushFn = Object.values(fns).find((f: unknown) => {
      const props = (f as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties;
      const vars = props.Environment?.Variables ?? {};
      return 'CAP_TABLE_NAME' in vars;
    }) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
    expect(pushFn).toBeDefined();
    const vars = pushFn!.Properties.Environment.Variables;
    expect(vars.CAP_TABLE_NAME).toBeDefined();
    expect(vars.RDS_ENDPOINT).toBeDefined();
    expect(vars.RDS_SECRET_ARN).toBeDefined();
    expect(vars.TELEGRAM_BOT_TOKEN_SECRET_ARN).toBeDefined();
  });

  it('creates an SNS topic + email subscription to kevin@tale-forge.app', () => {
    tpl.resourceCountIs('AWS::SNS::Topic', 1);
    tpl.hasResourceProperties(
      'AWS::SNS::Subscription',
      Match.objectLike({
        Protocol: 'email',
        Endpoint: 'kevin@tale-forge.app',
      }),
    );
  });

  it('creates AWS::Budgets::Budget kos-monthly with COST + MONTHLY', () => {
    tpl.hasResourceProperties(
      'AWS::Budgets::Budget',
      Match.objectLike({
        Budget: Match.objectLike({
          BudgetName: 'kos-monthly',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          BudgetLimit: Match.objectLike({ Amount: 100, Unit: 'USD' }),
        }),
      }),
    );
  });

  it('has 3 Budget notifications — 50 actual, 100 actual, 100 forecasted', () => {
    const budgets = tpl.findResources('AWS::Budgets::Budget');
    const keys = Object.keys(budgets);
    expect(keys.length).toBe(1);
    const budget = budgets[keys[0]!]!;
    const notifs = (budget as { Properties: { NotificationsWithSubscribers: Array<{ Notification: Record<string, unknown> }> } })
      .Properties.NotificationsWithSubscribers;
    expect(notifs.length).toBe(3);
    const summaries = notifs.map((n) => ({
      type: n.Notification.NotificationType,
      threshold: n.Notification.Threshold,
      op: n.Notification.ComparisonOperator,
    }));
    expect(summaries).toContainEqual({ type: 'ACTUAL', threshold: 50, op: 'GREATER_THAN' });
    expect(summaries).toContainEqual({ type: 'ACTUAL', threshold: 100, op: 'GREATER_THAN' });
    expect(summaries).toContainEqual({ type: 'FORECASTED', threshold: 100, op: 'GREATER_THAN' });
  });

  it('SNS topic policy scopes Budgets publish by aws:SourceArn kos-monthly', () => {
    const policies = tpl.findResources('AWS::SNS::TopicPolicy');
    const policyValues = Object.values(policies);
    expect(policyValues.length).toBeGreaterThanOrEqual(1);
    // At least one statement must bind budgets.amazonaws.com + have ArnLike SourceArn on kos-monthly.
    const serialised = JSON.stringify(policyValues);
    expect(serialised).toContain('budgets.amazonaws.com');
    expect(serialised).toContain('budget/kos-monthly');
    expect(serialised).toContain('aws:SourceArn');
  });
});
