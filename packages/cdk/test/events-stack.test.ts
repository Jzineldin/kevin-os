import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { EventsStack } from '../lib/stacks/events-stack';

describe('EventsStack', () => {
  const app = new App();
  const stack = new EventsStack(app, 'TE', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const tpl = Template.fromStack(stack);

  it('creates 5 kos.* EventBridge buses', () => {
    const buses = tpl.findResources('AWS::Events::EventBus');
    const names = Object.values(buses).map((b: any) => b.Properties.Name);
    expect(names.sort()).toEqual([
      'kos.agent',
      'kos.capture',
      'kos.output',
      'kos.system',
      'kos.triage',
    ]);
  });

  it('each bus has a resource policy restricting to same account', () => {
    tpl.resourceCountIs('AWS::Events::EventBusPolicy', 5);
    const policies = tpl.findResources('AWS::Events::EventBusPolicy');
    for (const p of Object.values(policies)) {
      expect((p as any).Properties.Action).toBe('events:PutEvents');
      expect((p as any).Properties.Principal).toEqual('123456789012');
    }
  });

  it('creates 5 DLQs with 14-day retention', () => {
    const queues = tpl.findResources('AWS::SQS::Queue');
    expect(Object.keys(queues).length).toBe(5);
    for (const q of Object.values(queues)) {
      expect((q as any).Properties.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
    }
  });

  it('creates kos-schedules Scheduler group', () => {
    tpl.hasResourceProperties(
      'AWS::Scheduler::ScheduleGroup',
      Match.objectLike({ Name: 'kos-schedules' }),
    );
  });
});
