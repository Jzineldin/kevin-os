/**
 * Plan 08-02 (AGT-07) content-writer CDK wiring tests.
 *
 * 8 assertions:
 *   1. Step Functions state machine `kos-content-writer-5platform` exists.
 *   2. State machine type is STANDARD (not EXPRESS).
 *   3. Map state has maxConcurrency=5.
 *   4. platformWorker has bedrock:InvokeModel grant scoped to Sonnet 4.6 EU.
 *   5. orchestrator has states:StartExecution grant on the state machine ARN.
 *   6. platformWorker has rds-db:connect as kos_content_writer_platform.
 *   7. SAFETY: orchestrator policy has ZERO bedrock:* actions (IAM grep).
 *   8. SAFETY: neither Lambda has postiz:* or ses:* grants.
 */
import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { wireContentWriter } from '../lib/stacks/integrations-content.js';

function makeStack() {
  const app = new App();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const vpc = new Vpc(stack, 'V');
  const sg = new SecurityGroup(stack, 'Sg', { vpc });
  const agentBus = new EventBus(stack, 'agent', { eventBusName: 'kos.agent' });
  const sentry = new Secret(stack, 'sentry');
  const langfusePub = new Secret(stack, 'lfp');
  const langfuseSec = new Secret(stack, 'lfs');
  const wiring = wireContentWriter(stack, {
    vpc,
    rdsSecurityGroup: sg,
    rdsProxyEndpoint: 'fake.rds.example',
    rdsProxyDbiResourceId: 'prx-fake',
    agentBus,
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
    sentryDsnSecret: sentry,
    langfusePublicKeySecret: langfusePub,
    langfuseSecretKeySecret: langfuseSec,
  });
  return { stack, wiring };
}

interface PolicyResource {
  Properties?: {
    PolicyDocument?: {
      Statement?: Array<{
        Action?: string | string[];
        Resource?: string | string[];
      }>;
    };
    Roles?: Array<{ Ref?: string }>;
  };
}

interface SfnResource {
  Properties?: {
    StateMachineName?: string;
    StateMachineType?: string;
    DefinitionString?: unknown;
    Definition?: unknown;
  };
}

interface LambdaResource {
  Properties?: {
    Environment?: { Variables?: Record<string, unknown> };
  };
}

describe('Plan 08-02 wireContentWriter', () => {
  it('1. Step Functions state machine kos-content-writer-5platform exists', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const machines = t.findResources('AWS::StepFunctions::StateMachine');
    const matched = Object.values(machines).find(
      (m) => (m as SfnResource).Properties?.StateMachineName === 'kos-content-writer-5platform',
    );
    expect(matched).toBeDefined();
  });

  it('2. State machine type is STANDARD (not EXPRESS)', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const machines = t.findResources('AWS::StepFunctions::StateMachine');
    const m = Object.values(machines).find(
      (x) => (x as SfnResource).Properties?.StateMachineName === 'kos-content-writer-5platform',
    ) as SfnResource | undefined;
    // Default StateMachineType is STANDARD; CDK omits the property when not
    // explicitly set to EXPRESS. Accept either { StateMachineType: 'STANDARD' }
    // or undefined (the default).
    const type = m?.Properties?.StateMachineType;
    expect(type === undefined || type === 'STANDARD').toBe(true);
  });

  it('3. Map state has maxConcurrency=5', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const machines = t.findResources('AWS::StepFunctions::StateMachine');
    const m = Object.values(machines).find(
      (x) => (x as SfnResource).Properties?.StateMachineName === 'kos-content-writer-5platform',
    ) as SfnResource | undefined;
    // CDK serialises Definition as either an object or a CFN intrinsic
    // (DefinitionString → Fn::Join). The MaxConcurrency literal still appears
    // verbatim inside the joined ASL string — match against the doubly-quoted
    // form (the JSON.stringify of a DefinitionString CFN-Join produces
    // backslash-escaped `\"MaxConcurrency\":5`).
    const def = JSON.stringify(m?.Properties);
    expect(def).toMatch(/MaxConcurrency\\?":\s*5/);
  });

  it('4. platformWorker has bedrock:InvokeModel grant scoped to Sonnet 4.6 EU profile', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const bedrockResources = Object.values(policies).flatMap((p) =>
      ((p as PolicyResource).Properties?.PolicyDocument?.Statement ?? [])
        .filter((s) => {
          const action = Array.isArray(s.Action) ? s.Action : [s.Action];
          return action.includes('bedrock:InvokeModel');
        })
        .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])),
    );
    const haystack = JSON.stringify(bedrockResources);
    expect(haystack).toMatch(/eu\.anthropic\.claude-sonnet-4-6/);
    // Sanity: NO Haiku / Opus model in the platform-worker grant.
    expect(haystack).not.toMatch(/eu\.anthropic\.claude-haiku/);
    expect(haystack).not.toMatch(/eu\.anthropic\.claude-opus/);
  });

  it('5. orchestrator has states:StartExecution on the state machine ARN', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const startExecStmts = Object.values(policies).flatMap((p) =>
      ((p as PolicyResource).Properties?.PolicyDocument?.Statement ?? []).filter((s) => {
        const action = Array.isArray(s.Action) ? s.Action : [s.Action];
        return action.includes('states:StartExecution');
      }),
    );
    expect(startExecStmts.length).toBeGreaterThan(0);
  });

  it('6. platformWorker has rds-db:connect as kos_content_writer_platform', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const rdsStmts = Object.values(policies).flatMap((p) =>
      ((p as PolicyResource).Properties?.PolicyDocument?.Statement ?? []).filter((s) => {
        const action = Array.isArray(s.Action) ? s.Action : [s.Action];
        return action.includes('rds-db:connect');
      }),
    );
    const haystack = JSON.stringify(rdsStmts);
    expect(haystack).toMatch(/kos_content_writer_platform/);
    expect(haystack).toMatch(/kos_content_writer_orchestrator/);
  });

  it('7. SAFETY: orchestrator policy has ZERO bedrock:* actions', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    // Find policies attached to the orchestrator role (logical id contains "ContentWriter"
    // but NOT "ContentWriterPlatform" or "ContentWriterStateMachine").
    const orchestratorActions = Object.values(policies)
      .filter((p) => {
        const roles = (p as PolicyResource).Properties?.Roles ?? [];
        return roles.some((r) => {
          const ref = r.Ref ?? '';
          return (
            ref.includes('ContentWriter') &&
            !ref.includes('ContentWriterPlatform') &&
            !ref.includes('StateMachine')
          );
        });
      })
      .flatMap((p) =>
        ((p as PolicyResource).Properties?.PolicyDocument?.Statement ?? []).flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : [s.Action],
        ),
      );
    const bedrockActions = orchestratorActions.filter(
      (a) => typeof a === 'string' && a.toLowerCase().startsWith('bedrock:'),
    );
    expect(bedrockActions).toEqual([]);
  });

  it('8. SAFETY: neither Lambda has postiz:* or ses:* grants', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const allActions = Object.values(policies).flatMap((p) =>
      ((p as PolicyResource).Properties?.PolicyDocument?.Statement ?? []).flatMap((s) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ),
    );
    const forbidden = allActions.filter(
      (a) =>
        typeof a === 'string' &&
        (a.toLowerCase().startsWith('postiz:') || a.toLowerCase().startsWith('ses:')),
    );
    expect(forbidden).toEqual([]);
  });

  it('9. EventBridge rule fires on kos.agent / content.topic_submitted', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const rules = t.findResources('AWS::Events::Rule');
    const matched = Object.values(rules).find((r) => {
      const pat = JSON.stringify(
        (r as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern ?? {},
      );
      return pat.includes('"kos.agent"') && pat.includes('content.topic_submitted');
    });
    expect(matched).toBeDefined();
  });

  it('10. orchestrator env vars: SFN_CONTENT_WRITER_ARN, RDS_IAM_USER, KEVIN_OWNER_ID', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find(
      (l) =>
        (l as LambdaResource).Properties?.Environment?.Variables?.RDS_IAM_USER ===
        'kos_content_writer_orchestrator',
    ) as LambdaResource | undefined;
    const env = fn?.Properties?.Environment?.Variables ?? {};
    expect(env.RDS_IAM_USER).toBe('kos_content_writer_orchestrator');
    expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
    expect(env.SFN_CONTENT_WRITER_ARN).toBeDefined();
  });
});
