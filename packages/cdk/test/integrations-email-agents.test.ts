/**
 * Plan 04-04 (AGT-05) email-triage CDK wiring tests.
 *
 * 8 assertions:
 *   1. Lambda exists with memory=1024, timeout=5min, VPC-attached
 *   2. Bedrock InvokeModel scoped to Haiku 4.5 + Sonnet 4.6 EU profiles
 *   3. rds-db:connect for kos_email_triage role
 *   4. events:PutEvents for the output bus (draft_ready emit)
 *   5. STRUCTURAL: NO ses:* IAM action in the Lambda's role (drift detection)
 *   6. EventBridge rule on kos.capture / capture.received / kind in (email_inbox, email_forward)
 *   7. EventBridge rule on kos.system / scan_emails_now
 *   8. Lambda env: RDS_PROXY_ENDPOINT, RDS_IAM_USER=kos_email_triage,
 *      KEVIN_OWNER_ID, OUTPUT_BUS_NAME
 */
import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { wireEmailAgents } from '../lib/stacks/integrations-email-agents.js';

function makeStack() {
  const app = new App();
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const vpc = new Vpc(stack, 'V');
  const sg = new SecurityGroup(stack, 'Sg', { vpc });
  const captureBus = new EventBus(stack, 'cap', { eventBusName: 'kos.capture' });
  const outputBus = new EventBus(stack, 'out', { eventBusName: 'kos.output' });
  const systemBus = new EventBus(stack, 'sys', { eventBusName: 'kos.system' });
  const sentry = new Secret(stack, 'sentry');
  const langfusePub = new Secret(stack, 'lfp');
  const langfuseSec = new Secret(stack, 'lfs');
  const notion = new Secret(stack, 'notion');
  const azure = new Secret(stack, 'azs');
  const wiring = wireEmailAgents(stack, {
    vpc,
    rdsSecurityGroup: sg,
    rdsProxyEndpoint: 'fake.rds.example',
    rdsProxyDbiResourceId: 'prx-fake',
    captureBus,
    outputBus,
    systemBus,
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
    sentryDsnSecret: sentry,
    langfusePublicKeySecret: langfusePub,
    langfuseSecretKeySecret: langfuseSec,
    notionTokenSecret: notion,
    azureSearchAdminSecret: azure,
  });
  return { stack, wiring };
}

describe('Plan 04-04 wireEmailAgents', () => {
  it('1. Lambda exists with memory=1024, timeout=5min, VPC-attached', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find(
      (l: unknown) =>
        (l as { Properties?: { Environment?: { Variables?: { RDS_IAM_USER?: string } } } })
          .Properties?.Environment?.Variables?.RDS_IAM_USER === 'kos_email_triage',
    ) as { Properties?: Record<string, unknown> } | undefined;
    expect(fn).toBeDefined();
    expect(fn?.Properties?.MemorySize).toBe(1024);
    expect(fn?.Properties?.Timeout).toBe(300); // 5 min
    expect(fn?.Properties?.VpcConfig).toBeDefined();
  });

  it('2. Bedrock InvokeModel scoped to Haiku 4.5 + Sonnet 4.6 EU profiles', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const bedrockResources = Object.values(policies).flatMap((p: unknown) =>
      (
        (p as { Properties?: { PolicyDocument?: { Statement?: Array<{
          Action?: string | string[]; Resource?: string | string[];
        }> } } }).Properties?.PolicyDocument?.Statement ?? []
      )
        .filter((s) => {
          const action = Array.isArray(s.Action) ? s.Action : [s.Action];
          return action.includes('bedrock:InvokeModel');
        })
        .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])),
    );
    const haystack = JSON.stringify(bedrockResources);
    expect(haystack).toMatch(/eu\.anthropic\.claude-haiku-4-5/);
    expect(haystack).toMatch(/eu\.anthropic\.claude-sonnet-4-6/);
  });

  it('3. rds-db:connect for kos_email_triage', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const rdsStatements = Object.values(policies).flatMap((p: unknown) =>
      (
        (p as { Properties?: { PolicyDocument?: { Statement?: Array<{
          Action?: string | string[]; Resource?: string | string[];
        }> } } }).Properties?.PolicyDocument?.Statement ?? []
      ).filter((s) => {
        const action = Array.isArray(s.Action) ? s.Action : [s.Action];
        return action.includes('rds-db:connect');
      }),
    );
    expect(rdsStatements.length).toBeGreaterThan(0);
    expect(JSON.stringify(rdsStatements)).toMatch(/kos_email_triage/);
  });

  it('4. events:PutEvents on the output bus', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    const putEventsStmts = Object.values(policies).flatMap((p: unknown) =>
      (
        (p as { Properties?: { PolicyDocument?: { Statement?: Array<{
          Action?: string | string[]; Resource?: unknown;
        }> } } }).Properties?.PolicyDocument?.Statement ?? []
      ).filter((s) => {
        const action = Array.isArray(s.Action) ? s.Action : [s.Action];
        return action.includes('events:PutEvents');
      }),
    );
    expect(putEventsStmts.length).toBeGreaterThan(0);
  });

  it('5. STRUCTURAL: NO ses:* action in any policy attached to email-triage', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const policies = t.findResources('AWS::IAM::Policy');
    // Scope to policies whose Roles ref EmailTriageAgent's role logical id —
    // the unified wireEmailAgents helper also wires email-sender (which DOES
    // have ses:SendRawEmail), so a global scan would catch the wrong policy.
    const triageActions = Object.values(policies)
      .filter((p: unknown) => {
        const roles =
          (p as { Properties?: { Roles?: Array<{ Ref?: string }> } }).Properties
            ?.Roles ?? [];
        return roles.some((r) => (r.Ref ?? '').includes('EmailTriageAgent'));
      })
      .flatMap((p: unknown) =>
        (
          (p as { Properties?: { PolicyDocument?: { Statement?: Array<{
            Action?: string | string[];
          }> } } }).Properties?.PolicyDocument?.Statement ?? []
        ).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])),
      );
    const sesActions = triageActions.filter(
      (a) => typeof a === 'string' && a.toLowerCase().startsWith('ses:'),
    );
    expect(sesActions).toEqual([]);
  });

  it('6. EventBridge rule on kos.capture / capture.received / kind in {email_inbox, email_forward}', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const rules = t.findResources('AWS::Events::Rule');
    const captureRule = Object.values(rules).find((r: unknown) => {
      const pat = (r as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern;
      const s = JSON.stringify(pat ?? {});
      return s.includes('"kos.capture"') && s.includes('email_inbox');
    });
    expect(captureRule).toBeDefined();
    const pattern = JSON.stringify(
      (captureRule as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern,
    );
    expect(pattern).toMatch(/email_inbox/);
    expect(pattern).toMatch(/email_forward/);
    expect(pattern).toMatch(/capture\.received/);
  });

  it('7. EventBridge rule on kos.system / scan_emails_now', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const rules = t.findResources('AWS::Events::Rule');
    const scanRule = Object.values(rules).find((r: unknown) => {
      const s = JSON.stringify(
        (r as { Properties?: { EventPattern?: unknown } }).Properties?.EventPattern ?? {},
      );
      return s.includes('"kos.system"') && s.includes('scan_emails_now');
    });
    expect(scanRule).toBeDefined();
  });

  it('8. Lambda env vars: RDS_PROXY_ENDPOINT, RDS_IAM_USER, KEVIN_OWNER_ID, OUTPUT_BUS_NAME', () => {
    const { stack } = makeStack();
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const fn = Object.values(lambdas).find(
      (l: unknown) =>
        (l as { Properties?: { Environment?: { Variables?: { RDS_IAM_USER?: string } } } })
          .Properties?.Environment?.Variables?.RDS_IAM_USER === 'kos_email_triage',
    ) as
      | {
          Properties?: {
            Environment?: { Variables?: Record<string, unknown> };
          };
        }
      | undefined;
    const env = fn?.Properties?.Environment?.Variables ?? {};
    expect(env.RDS_PROXY_ENDPOINT).toBe('fake.rds.example');
    expect(env.RDS_IAM_USER).toBe('kos_email_triage');
    expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
    // OUTPUT_BUS_NAME resolves to a CDK Ref token at synth time (the bus
    // logical id), not the literal name. Asserting the Ref shape keeps the
    // test useful even if EventBridge logical ids drift.
    expect(env.OUTPUT_BUS_NAME).toBeDefined();
    expect(JSON.stringify(env.OUTPUT_BUS_NAME)).toMatch(/(Ref|kos\.output)/);
  });
});
