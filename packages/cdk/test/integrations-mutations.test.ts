/**
 * Plan 08-04 (AGT-08) mutation-pipeline CDK wiring tests.
 *
 * 10 IAM-safety + wiring assertions:
 *   1.  MutationProposer Lambda — memory=1024, timeout=2min, VPC-attached
 *   2.  MutationExecutor Lambda — memory=512, timeout=30s, VPC-attached
 *   3.  Proposer has bedrock:InvokeModel scoped to Haiku + Sonnet EU profiles
 *   4.  Executor has NO bedrock:* grant
 *   5.  Executor has NO postiz/ses/googleapis-shaped IAM
 *   6.  Proposer has NO postiz/ses-shaped IAM
 *   7.  Proposer rds-db:connect as kos_mutation_proposer
 *   8.  Executor rds-db:connect as kos_mutation_executor
 *   9.  EventBridge rule on capture.received[text|voice_transcribed] → proposer
 *  10.  EventBridge rule on pending_mutation.approved → executor
 */
import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { wireMutationPipeline } from '../lib/stacks/integrations-mutations.js';

function makeStack() {
  const app = new App();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const vpc = new Vpc(stack, 'V');
  const sg = new SecurityGroup(stack, 'Sg', { vpc });
  const captureBus = new EventBus(stack, 'cap', { eventBusName: 'kos.capture' });
  const agentBus = new EventBus(stack, 'agent', { eventBusName: 'kos.agent' });
  const outputBus = new EventBus(stack, 'out', { eventBusName: 'kos.output' });
  const notion = new Secret(stack, 'notion');
  const wiring = wireMutationPipeline(stack, {
    vpc,
    rdsSecurityGroup: sg,
    rdsProxyEndpoint: 'fake.rds.example',
    rdsProxyDbiResourceId: 'prx-fake',
    captureBus,
    agentBus,
    outputBus,
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
    notionTokenSecret: notion,
  });
  return { stack, wiring };
}

interface PolicyStmt {
  Action?: string | string[];
  Resource?: string | string[];
}
interface PolicyDoc {
  Properties?: {
    PolicyDocument?: { Statement?: PolicyStmt[] };
    Roles?: Array<{ Ref?: string }>;
  };
}

function flattenActions(policies: Record<string, unknown>, refContains: string): string[] {
  return Object.values(policies)
    .filter((p) => {
      const roles = (p as PolicyDoc).Properties?.Roles ?? [];
      return roles.some((r) => (r.Ref ?? '').includes(refContains));
    })
    .flatMap((p) =>
      ((p as PolicyDoc).Properties?.PolicyDocument?.Statement ?? []).flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action ?? ''],
      ),
    );
}

function flattenStatements(policies: Record<string, unknown>, refContains: string): PolicyStmt[] {
  return Object.values(policies)
    .filter((p) => {
      const roles = (p as PolicyDoc).Properties?.Roles ?? [];
      return roles.some((r) => (r.Ref ?? '').includes(refContains));
    })
    .flatMap((p) => (p as PolicyDoc).Properties?.PolicyDocument?.Statement ?? []);
}

describe('Plan 08-04 wireMutationPipeline', () => {
  it('1. MutationProposer Lambda — memory=1024, timeout=2min, VPC-attached', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find(
      (l: unknown) =>
        (l as { Properties?: { Environment?: { Variables?: { RDS_IAM_USER?: string } } } })
          .Properties?.Environment?.Variables?.RDS_IAM_USER === 'kos_mutation_proposer',
    ) as { Properties?: Record<string, unknown> } | undefined;
    expect(fn).toBeDefined();
    expect(fn?.Properties?.MemorySize).toBe(1024);
    expect(fn?.Properties?.Timeout).toBe(120);
    expect(fn?.Properties?.VpcConfig).toBeDefined();
  });

  it('2. MutationExecutor Lambda — memory=512, timeout=30s, VPC-attached', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find(
      (l: unknown) =>
        (l as { Properties?: { Environment?: { Variables?: { RDS_IAM_USER?: string } } } })
          .Properties?.Environment?.Variables?.RDS_IAM_USER === 'kos_mutation_executor',
    ) as { Properties?: Record<string, unknown> } | undefined;
    expect(fn).toBeDefined();
    expect(fn?.Properties?.MemorySize).toBe(512);
    expect(fn?.Properties?.Timeout).toBe(30);
    expect(fn?.Properties?.VpcConfig).toBeDefined();
  });

  it('3. Proposer has bedrock:InvokeModel scoped to Haiku + Sonnet EU profiles', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const stmts = flattenStatements(policies, 'MutationProposer');
    const bedrockResources = stmts
      .filter((s) => {
        const action = Array.isArray(s.Action) ? s.Action : [s.Action];
        return action.includes('bedrock:InvokeModel');
      })
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource ?? '']));
    const haystack = JSON.stringify(bedrockResources);
    expect(haystack).toMatch(/eu\.anthropic\.claude-haiku-4-5/);
    expect(haystack).toMatch(/eu\.anthropic\.claude-sonnet-4-6/);
  });

  it('4. Executor has NO bedrock:* grant', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const actions = flattenActions(policies, 'MutationExecutor');
    const bedrockActions = actions.filter(
      (a) => typeof a === 'string' && a.toLowerCase().startsWith('bedrock:'),
    );
    expect(bedrockActions).toEqual([]);
  });

  it('5. Executor has NO postiz/ses/googleapis-shaped IAM', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const actions = flattenActions(policies, 'MutationExecutor');
    const banned = actions.filter((a) => {
      const lower = (a ?? '').toLowerCase();
      return (
        lower.startsWith('ses:') ||
        lower.startsWith('postiz:') ||
        lower.includes('googleapi') ||
        lower.startsWith('calendar:')
      );
    });
    expect(banned).toEqual([]);
  });

  it('6. Proposer has NO postiz/ses-shaped IAM', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const actions = flattenActions(policies, 'MutationProposer');
    const banned = actions.filter((a) => {
      const lower = (a ?? '').toLowerCase();
      return lower.startsWith('ses:') || lower.startsWith('postiz:');
    });
    expect(banned).toEqual([]);
  });

  it('7. Proposer rds-db:connect as kos_mutation_proposer', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const stmts = flattenStatements(policies, 'MutationProposer');
    const rdsStmts = stmts.filter((s) => {
      const action = Array.isArray(s.Action) ? s.Action : [s.Action];
      return action.includes('rds-db:connect');
    });
    expect(rdsStmts.length).toBeGreaterThan(0);
    expect(JSON.stringify(rdsStmts)).toMatch(/kos_mutation_proposer/);
  });

  it('8. Executor rds-db:connect as kos_mutation_executor', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const stmts = flattenStatements(policies, 'MutationExecutor');
    const rdsStmts = stmts.filter((s) => {
      const action = Array.isArray(s.Action) ? s.Action : [s.Action];
      return action.includes('rds-db:connect');
    });
    expect(rdsStmts.length).toBeGreaterThan(0);
    expect(JSON.stringify(rdsStmts)).toMatch(/kos_mutation_executor/);
  });

  it('9. EventBridge rule on capture.received[text|voice_transcribed] → proposer', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const rules = t.findResources('AWS::Events::Rule');
    const captureRule = Object.values(rules).find((r: unknown) => {
      const pat = (r as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern;
      const s = JSON.stringify(pat ?? {});
      return s.includes('"kos.capture"') && s.includes('voice_transcribed');
    });
    expect(captureRule).toBeDefined();
    const pattern = JSON.stringify(
      (captureRule as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern,
    );
    expect(pattern).toMatch(/capture\.received/);
    expect(pattern).toMatch(/voice_transcribed/);
    expect(pattern).toMatch(/text/);
  });

  it('10. EventBridge rule on pending_mutation.approved → executor', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const rules = t.findResources('AWS::Events::Rule');
    const apprRule = Object.values(rules).find((r: unknown) => {
      const s = JSON.stringify(
        (r as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern ?? {},
      );
      return s.includes('"kos.output"') && s.includes('pending_mutation.approved');
    });
    expect(apprRule).toBeDefined();
  });
});
