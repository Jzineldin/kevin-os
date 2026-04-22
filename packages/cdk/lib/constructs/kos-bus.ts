import { Construct } from 'constructs';
import { Stack, Duration } from 'aws-cdk-lib';
import { EventBus, CfnEventBusPolicy } from 'aws-cdk-lib/aws-events';
import { Queue } from 'aws-cdk-lib/aws-sqs';

export interface KosBusProps {
  /** Short name, e.g. 'capture' — bus becomes `kos.${name}` */
  shortName: 'capture' | 'triage' | 'agent' | 'output' | 'system';
}

/**
 * KOS custom EventBridge bus + companion DLQ + same-account PutEvents policy.
 *
 * - Bus name is `kos.${shortName}` (load-bearing across all 10 phases per
 *   .planning/phases/01-infrastructure-foundation/01-CONTEXT.md §specifics).
 * - Resource policy restricts `events:PutEvents` to the deploying account
 *   (STRIDE T-01-03: cross-account publish mitigation).
 * - DLQ uses the 14-day retention that Phase 2+ targets will point at.
 */
export class KosBus extends Construct {
  public readonly bus: EventBus;
  public readonly dlq: Queue;

  constructor(scope: Construct, id: string, props: KosBusProps) {
    super(scope, id);

    this.bus = new EventBus(this, 'Bus', {
      eventBusName: `kos.${props.shortName}`,
    });

    // Restrict PutEvents to the same AWS account (T-01-03)
    new CfnEventBusPolicy(this, 'BusPolicy', {
      eventBusName: this.bus.eventBusName,
      statementId: `${props.shortName}-same-account-put-events`,
      action: 'events:PutEvents',
      principal: Stack.of(this).account,
    });

    this.dlq = new Queue(this, 'Dlq', {
      queueName: `kos-${props.shortName}-dlq`,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });
  }
}
