import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EventsStack } from '../lib/stacks/events-stack';
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
  const events = new EventsStack(app, 'E', { env });
  const safety = new SafetyStack(app, 'S', {
    env,
    vpc: net.vpc,
    rdsSecurityGroup: data.rdsSecurityGroup,
    rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
    rdsSecret: data.rdsCredentialsSecret,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    telegramBotTokenSecret: data.telegramBotTokenSecret,
    // Plan 02-06 — push-telegram is now an EB target on kos.output.
    outputBus: events.buses.output,
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

  it('creates the push-telegram Lambda (nodejs22.x, arm64) inside the VPC', () => {
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        // push-telegram runs inside the VPC (Wave 5 architectural change for RDS access).
        VpcConfig: Match.objectLike({
          SubnetIds: Match.anyValue(),
        }),
      }),
    );
  });

  it('wires CAP_TABLE_NAME + RDS_ENDPOINT + RDS_SECRET_ARN into the Lambda env', () => {
    // Find the lambda function and check env keys exist.
    const fns = tpl.findResources('AWS::Lambda::Function');
    const pushFn = Object.values(fns).find((f: unknown) => {
      const props = (f as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties;
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

  // NOTE: AWS::Budgets::Budget CFN resource is not available in eu-north-1
  // (only us-east-1). The budget is created out-of-band via
  // scripts/create-cost-budget.sh against the deployed alarmTopic ARN; see
  // safety-stack.ts comment block for rationale. Synth-level tests for the
  // budget shape are not meaningful here.

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

  // --- Plan 02-06 / OUT-01: EventBridge rule on kos.output ---------------
  it('creates a Rule on kos.output matching detail-type=output.push targeting push-telegram', () => {
    tpl.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['kos.output'],
          'detail-type': ['output.push'],
        }),
      }),
    );
    // And the rule must have a DLQ (DeadLetterConfig on the target).
    const rules = tpl.findResources('AWS::Events::Rule');
    const pushRule = Object.values(rules).find((r: unknown) => {
      const props = (r as { Properties: { EventPattern?: { source?: string[] } } }).Properties;
      return props.EventPattern?.source?.[0] === 'kos.output';
    }) as { Properties: { Targets: Array<{ DeadLetterConfig?: unknown }> } } | undefined;
    expect(pushRule).toBeDefined();
    expect(pushRule!.Properties.Targets.length).toBeGreaterThan(0);
    expect(pushRule!.Properties.Targets[0]!.DeadLetterConfig).toBeDefined();
  });

  it('creates the kos-push-telegram-dlq SQS queue', () => {
    tpl.hasResourceProperties(
      'AWS::SQS::Queue',
      Match.objectLike({ QueueName: 'kos-push-telegram-dlq' }),
    );
  });

  it('Lambda execution role includes GetSecretValue permission for telegram bot token', () => {
    // The telegramBotTokenSecret.grantRead() was already wired in Phase 1
    // (PLACEHOLDER secret); Plan 02-06 now actually consumes it at runtime.
    // Verify the grant is present by scanning all IAM policies for a
    // GetSecretValue action — at least one policy must reference the
    // telegram-bot-token secret ARN.
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialised = JSON.stringify(Object.values(policies));
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    // The secret logical-id prefix `TelegramBotToken` comes from DataStack
    // and is reachable via Fn::ImportValue in safety-stack tests.
    expect(serialised.toLowerCase()).toContain('telegram');
  });
});
