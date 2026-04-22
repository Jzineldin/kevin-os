import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { KosBus } from '../constructs/kos-bus';

const BUS_SHORT_NAMES = ['capture', 'triage', 'agent', 'output', 'system'] as const;
type ShortName = (typeof BUS_SHORT_NAMES)[number];

/**
 * EventsStack — the five load-bearing KOS EventBridge buses, each with a DLQ
 * and a same-account PutEvents resource policy, plus an empty EventBridge
 * Scheduler group (`kos-schedules`) that Plans 04 and 07 populate.
 *
 * The bus names `kos.capture`, `kos.triage`, `kos.agent`, `kos.output`,
 * `kos.system` are referenced across 10 phases (see
 * .planning/phases/01-infrastructure-foundation/01-CONTEXT.md §specifics)
 * and MUST NOT change.
 *
 * Per Research §"Don't Hand-Roll" (line 621) we use EventBridge Scheduler
 * (IANA timezone `Europe/Stockholm`), not EventBridge cron rules. Schedules
 * placed inside this group set `scheduleExpressionTimezone: 'Europe/Stockholm'`
 * per-schedule — the group itself only namespaces them.
 */
export class EventsStack extends Stack {
  public readonly buses: Record<ShortName, EventBus>;
  public readonly dlqs: Record<ShortName, Queue>;
  public readonly scheduleGroupName: string = 'kos-schedules';

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const buses = {} as Record<ShortName, EventBus>;
    const dlqs = {} as Record<ShortName, Queue>;
    for (const name of BUS_SHORT_NAMES) {
      const k = new KosBus(this, `KosBus-${name}`, { shortName: name });
      buses[name] = k.bus;
      dlqs[name] = k.dlq;
    }
    this.buses = buses;
    this.dlqs = dlqs;

    // Empty Scheduler group; Plan 04 adds notion-indexer schedules; Phase 7 adds AUTO-01/02/03.
    // Schedules within this group will set `scheduleExpressionTimezone: 'Europe/Stockholm'` per task.
    new CfnScheduleGroup(this, 'ScheduleGroup', { name: this.scheduleGroupName });
  }
}
