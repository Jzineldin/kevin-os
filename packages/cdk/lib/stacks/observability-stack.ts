/**
 * ObservabilityStack — Plan 02-10 (D-25 / D-26 + Resolved Open Q4).
 *
 * Provisions the Phase 2 CloudWatch alarm surface:
 *
 *   1. SNS topic `kos-observability-alarms` — fan-out for all alarms in this
 *      stack. Distinct from SafetyStack's CostAlarmTopic so the operator can
 *      mute one without losing the other (cost vs runtime are different
 *      response runbooks).
 *
 *   2. `TelegramBotP95LatencyHigh` (Resolved Open Q4) — fires when
 *      telegram-bot's p95 Duration metric exceeds 1800ms over a 5-minute
 *      window for 2 consecutive evaluation periods. The 1800ms threshold
 *      reflects the research-budget for "still feels instant on Kevin's
 *      phone" minus Lambda cold-start headroom; sustained breaches indicate
 *      we should consider provisioned concurrency on the bot Lambda.
 *      Plan 02-10 chose this over upfront provisioned concurrency
 *      (Resolved Q4 in 02-RESEARCH) — alarm-then-react is cheaper while
 *      Phase 2 traffic is bursty + low-volume.
 *
 *   3. `AgentErrorRateHigh-{LambdaId}` (one per agent Lambda) — fires when
 *      any single 15-minute window observes >5 Lambda Errors. At Phase 2
 *      volume that's effectively a >5% error-rate signal; the absolute
 *      count avoids false positives from single retries during normal flow.
 *
 *   4. `PushTelegramDlqDepth` — fires when push-telegram DLQ has any
 *      messages visible (an output.push event was retried twice and still
 *      failed). Treated as a notice-only signal.
 *
 * Per Plan 02-10 §threat_model T-02-OBS-04: alarm noise is bounded by
 * datapointsToAlarm=2 on the latency alarm and a 5-error threshold on the
 * agent error alarms. Single-user system, so Kevin's tolerance for noise
 * is high but we still guard against flapping.
 */
import { Stack, Duration, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';

export interface ObservabilityStackProps extends StackProps {
  /**
   * The CAP-01 Telegram bot Lambda. p95 Duration > 1800ms is the only
   * latency-class alarm we ship — every other Lambda's user-facing
   * latency is mediated by EventBridge so per-Lambda latency drift
   * matters less than end-to-end correlation in Langfuse.
   */
  telegramBotFn: IFunction;

  /**
   * The 3 agent Lambdas (triage, voice-capture, entity-resolver). One
   * alarm per Lambda — the bulk-import Lambdas are deliberately excluded
   * because they're operator-invoked one-shots and a "5 errors in 15min"
   * window is not meaningful for them (they either succeed once or fail
   * once per run).
   */
  agentLambdas: IFunction[];
}

export class ObservabilityStack extends Stack {
  public readonly alarmTopic: Topic;
  public readonly telegramBotLatencyAlarm: Alarm;
  public readonly agentErrorAlarms: Alarm[];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    this.alarmTopic = new Topic(this, 'KosAlarmTopic', {
      topicName: 'kos-observability-alarms',
      displayName: 'KOS Observability alarms (Plan 02-10)',
    });
    const action = new SnsAction(this.alarmTopic);

    // ---- Resolved Open Q4: telegram-bot cold-start watch ------------------
    this.telegramBotLatencyAlarm = new Alarm(this, 'TelegramBotP95LatencyHigh', {
      alarmName: 'kos-telegram-bot-p95-duration-high',
      alarmDescription:
        'telegram-bot p95 duration > 1800ms over 5-min window — investigate ' +
        'cold starts; consider provisioned concurrency if sustained',
      metric: props.telegramBotFn.metricDuration({
        statistic: 'p95',
        period: Duration.minutes(5),
      }),
      threshold: 1800,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    this.telegramBotLatencyAlarm.addAlarmAction(action);

    // ---- Per-agent error-rate watch ---------------------------------------
    this.agentErrorAlarms = [];
    for (const fn of props.agentLambdas) {
      const id = fn.node.id;
      const alarm = new Alarm(this, `AgentErrorRateHigh${id}`, {
        alarmName: `kos-${id.toLowerCase()}-error-rate-high`,
        alarmDescription:
          `${id} Lambda error count > 5 in 15-min window. At Phase 2 volume ` +
          `this is an effective >5% error-rate signal.`,
        metric: fn.metricErrors({
          statistic: 'Sum',
          period: Duration.minutes(15),
        }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      this.agentErrorAlarms.push(alarm);
    }
  }
}
