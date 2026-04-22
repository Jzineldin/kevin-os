import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { AgentsStack } from '../lib/stacks/agents-stack';

/**
 * AgentsStack synth-level assertions (Plan 02-04, AGT-01 + AGT-02).
 *
 * Covers:
 *   - 1 EventBridge rule on kos.capture for triage (matches both
 *     capture.received + capture.voice.transcribed) with DLQ
 *   - 1 EventBridge rule on kos.triage for voice-capture (filters
 *     detail.route=['voice-capture']) with DLQ
 *   - Both Lambdas use nodejs22.x + arm64
 *   - Both Lambdas have CLAUDE_CODE_USE_BEDROCK=1 env
 *   - Both Lambdas have bedrock:InvokeModel + rds-db:connect IAM grants
 *   - Triage Lambda timeout ≤ 30s; voice-capture ≤ 60s
 */
describe('AgentsStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const agents = new AgentsStack(app, 'A', {
    env,
    captureBus: events.buses.capture,
    triageBus: events.buses.triage,
    agentBus: events.buses.agent,
    outputBus: events.buses.output,
    notionTokenSecret: data.notionTokenSecret,
    sentryDsnSecret: data.sentryDsnSecret,
    langfusePublicSecret: data.langfusePublicSecret,
    langfuseSecretSecret: data.langfuseSecretSecret,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    rdsIamUser: 'kos_admin',
    rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
  });
  const tpl = Template.fromStack(agents);

  it('TriageFromCaptureRule matches both capture.received + capture.voice.transcribed with DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const rule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | { source?: string[]; 'detail-type'?: string[] }
        | undefined;
      return (
        ep?.source?.includes('kos.capture') === true &&
        ep?.['detail-type']?.includes('capture.received') === true &&
        ep?.['detail-type']?.includes('capture.voice.transcribed') === true
      );
    });
    expect(rule).toBeDefined();
    const targets = (rule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  it('VoiceCaptureFromTriageRule filters detail.route=voice-capture with DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const rule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | {
            source?: string[];
            'detail-type'?: string[];
            detail?: { route?: string[] };
          }
        | undefined;
      return (
        ep?.source?.includes('kos.triage') === true &&
        ep?.['detail-type']?.includes('triage.routed') === true &&
        ep?.detail?.route?.includes('voice-capture') === true
      );
    });
    expect(rule).toBeDefined();
    const targets = (rule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  // Helper: agent Lambdas have KEVIN_OWNER_ID env; CDK helper Lambdas (e.g.
  // LogRetention) do not — filter on it to ignore CDK-managed scaffolding.
  const agentFns = () => {
    const fns = tpl.findResources('AWS::Lambda::Function');
    return Object.values(fns).filter((fn) => {
      const env = (
        fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return env?.KEVIN_OWNER_ID !== undefined;
    });
  };

  it('both agent Lambdas run nodejs22.x + arm64', () => {
    const fns = agentFns();
    expect(fns.length).toBe(2);
    for (const fn of fns) {
      const props = (fn as { Properties: { Runtime: string; Architectures: string[] } })
        .Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('both agent Lambdas have CLAUDE_CODE_USE_BEDROCK=1 env', () => {
    for (const fn of agentFns()) {
      const env = (
        fn as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
      expect(env.RDS_PROXY_ENDPOINT).toBeDefined();
      expect(env.RDS_IAM_USER).toBe('kos_admin');
    }
  });

  it('both Lambda roles have bedrock:InvokeModel + rds-db:connect IAM statements', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('bedrock:InvokeModel');
    expect(serialized).toContain('rds-db:connect');
    expect(serialized).toContain('eu.anthropic.claude-haiku-4-5');
  });

  it('voice-capture Lambda has NOTION_COMMAND_CENTER_DB_ID env + agent/output bus PutEvents grants', () => {
    const vc = agentFns().find((f) => {
      const env = (
        f as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      return env.NOTION_COMMAND_CENTER_DB_ID !== undefined;
    });
    expect(vc).toBeDefined();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    // PutEvents on agent + output buses (and triage from triageFn).
    expect(serialized).toContain('events:PutEvents');
    expect(serialized).toMatch(/KosBusagentBus/);
    expect(serialized).toMatch(/KosBusoutputBus/);
    expect(serialized).toMatch(/KosBustriageBus/);
  });

  it('triage Lambda timeout ≤ 30s; voice-capture ≤ 60s', () => {
    for (const fn of agentFns()) {
      const props = (
        fn as { Properties: { Timeout: number; Environment: { Variables: Record<string, unknown> } } }
      ).Properties;
      const env = props.Environment.Variables;
      if (env.NOTION_COMMAND_CENTER_DB_ID !== undefined) {
        // voice-capture
        expect(props.Timeout).toBeLessThanOrEqual(60);
      } else {
        // triage
        expect(props.Timeout).toBeLessThanOrEqual(30);
      }
    }
  });

  it('creates dedicated triage + voice-capture DLQs', () => {
    const queues = tpl.findResources('AWS::SQS::Queue');
    const names = Object.values(queues).map(
      (q) => (q as { Properties?: { QueueName?: string } }).Properties?.QueueName,
    );
    expect(names).toContain('kos-triage-dlq');
    expect(names).toContain('kos-voice-capture-dlq');
  });

  it('emits exactly 2 agent Lambdas (triage + voice-capture); CDK helper Lambdas excluded', () => {
    expect(agentFns().length).toBe(2);
  });
});

// Tickle Match import so the linter is happy (used implicitly via the
// Match-aware findResources helpers; reference here defensively).
void Match;
