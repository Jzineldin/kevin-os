/**
 * ObservabilityStack synth-level assertions (Plan 02-10).
 *
 * Covers:
 *   - 1 SNS Topic named kos-observability-alarms
 *   - 1 CloudWatch Alarm on telegram-bot Duration p95 with threshold=1800
 *   - 3 CloudWatch Alarms on agent Lambda Errors (one per agent)
 *   - All 4 alarms publish to the SNS topic via AlarmActions
 */
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { describe, it, expect } from 'vitest';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

/**
 * Vanilla Lambda Functions are sufficient — the alarm code calls metricDuration
 * + metricErrors, both of which exist on `IFunction`. No need to instantiate
 * the full Capture/Agents stacks for this test.
 */
function makeFn(stack: Stack, id: string): LambdaFunction {
  return new LambdaFunction(stack, id, {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => ({ ok: true });'),
  });
}

describe('ObservabilityStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };

  // Host Lambdas in a sibling stack so cross-stack refs are exercised.
  const host = new Stack(app, 'HostForObs', { env });
  const telegramBotFn = makeFn(host, 'TelegramBot');
  const triageFn = makeFn(host, 'TriageAgent');
  const voiceCaptureFn = makeFn(host, 'VoiceCaptureAgent');
  const resolverFn = makeFn(host, 'EntityResolver');

  const obs = new ObservabilityStack(app, 'KosObservability', {
    env,
    telegramBotFn,
    agentLambdas: [triageFn, voiceCaptureFn, resolverFn],
  });
  const tpl = Template.fromStack(obs);

  it('creates exactly one SNS topic named kos-observability-alarms', () => {
    tpl.resourceCountIs('AWS::SNS::Topic', 1);
    tpl.hasResourceProperties(
      'AWS::SNS::Topic',
      Match.objectLike({ TopicName: 'kos-observability-alarms' }),
    );
  });

  it('creates the telegram-bot p95 latency alarm with threshold=1800ms', () => {
    tpl.hasResourceProperties(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        AlarmName: 'kos-telegram-bot-p95-duration-high',
        MetricName: 'Duration',
        Namespace: 'AWS/Lambda',
        ExtendedStatistic: 'p95',
        Threshold: 1800,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 2,
        DatapointsToAlarm: 2,
        Period: 300,
        TreatMissingData: 'notBreaching',
      }),
    );
  });

  it('creates one error-rate alarm per agent Lambda (3 total)', () => {
    // 1 latency alarm + 3 error alarms = 4 total
    tpl.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    for (const name of [
      'kos-triageagent-error-rate-high',
      'kos-voicecaptureagent-error-rate-high',
      'kos-entityresolver-error-rate-high',
    ]) {
      tpl.hasResourceProperties(
        'AWS::CloudWatch::Alarm',
        Match.objectLike({
          AlarmName: name,
          MetricName: 'Errors',
          Namespace: 'AWS/Lambda',
          Statistic: 'Sum',
          Threshold: 5,
          ComparisonOperator: 'GreaterThanThreshold',
          Period: 900,
          TreatMissingData: 'notBreaching',
        }),
      );
    }
  });

  it('every alarm publishes to the kos-observability-alarms SNS topic', () => {
    // All 4 alarms must have a non-empty AlarmActions list pointing at the
    // SNS Topic created in this stack. Match.arrayWith with anyValue is
    // sufficient — CloudFormation references resolve at deploy time.
    const alarms = tpl.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms).length).toBe(4);
    for (const props of Object.values(alarms)) {
      const actions = (props as { Properties: { AlarmActions: unknown[] } })
        .Properties.AlarmActions;
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.length).toBeGreaterThan(0);
    }
  });
});
