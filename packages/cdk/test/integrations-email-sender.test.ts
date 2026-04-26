/**
 * Plan 04-05 Task 3 — synth-level assertions for the email-sender Lambda
 * + the EmailApprovedRule.
 *
 * Six tests:
 *   1. EmailSender Lambda exists with timeout=30s, memory=512MB, ARM64.
 *   2. Lambda has `ses:SendRawEmail` on the tale-forge.app SES identity.
 *   3. Lambda has `rds-db:connect` as kos_email_sender (NOT kos_admin).
 *   4. Lambda has `events:PutEvents` on kos.output.
 *   5. SAFETY: IAM policy contains zero `"bedrock:` matches.
 *   6. EventBridge rule on kos.output/email.approved targets EmailSender.
 *
 * The threat model rests on assertion #5: a Bedrock-injected forged
 * `email.approved` event reaches the email-sender Lambda but the Lambda
 * cannot call Bedrock to "rewrite" the draft body before send — the
 * draft body comes from email_drafts (a row only kos_admin/kos_agent_writer
 * can write). So even a Lambda compromise can't draft new text.
 */
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { Vpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { wireEmailAgents } from '../lib/stacks/integrations-email-agents.js';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'KosIntegrationsEmail', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const vpc = new Vpc(stack, 'V');
  const sg = new SecurityGroup(stack, 'Sg', { vpc });
  const systemBus = new EventBus(stack, 'SystemBus', { eventBusName: 'kos.system' });
  const outputBus = new EventBus(stack, 'OutputBus', { eventBusName: 'kos.output' });
  const sentry = new Secret(stack, 'Sentry');
  const lfPub = new Secret(stack, 'LfPub');
  const lfSec = new Secret(stack, 'LfSec');
  wireEmailAgents(stack, {
    vpc,
    rdsSecurityGroup: sg,
    rdsProxyEndpoint: 'kos-rds.proxy-fake.eu-north-1.rds.amazonaws.com',
    rdsProxyDbiResourceId: 'prx-fake',
    systemBus,
    outputBus,
    kevinOwnerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
    sentryDsnSecret: sentry,
    langfusePublicSecret: lfPub,
    langfuseSecretSecret: lfSec,
  });
  return { tpl: Template.fromStack(stack) };
}

function findEmailSenderLambda(tpl: Template): { logicalId: string; props: Record<string, unknown> } {
  const fns = tpl.findResources('AWS::Lambda::Function');
  const entry = Object.entries(fns).find(([name, f]) => {
    const env = (f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables;
    return name.startsWith('EmailSender') && env && env.RDS_IAM_USER === 'kos_email_sender';
  });
  if (!entry) throw new Error('EmailSender Lambda not found in synth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { logicalId: entry[0], props: (entry[1] as any).Properties };
}

describe('IntegrationsEmail — email-sender Lambda (Plan 04-05)', () => {
  it('Test 1: EmailSender Lambda has timeout=30s, memory=512MB, arm64, nodejs22.x', () => {
    const { tpl } = synth();
    const { props } = findEmailSenderLambda(tpl);
    expect((props as { Timeout: number }).Timeout).toBe(30);
    expect((props as { MemorySize: number }).MemorySize).toBe(512);
    expect((props as { Architectures: string[] }).Architectures).toEqual(['arm64']);
    expect((props as { Runtime: string }).Runtime).toBe('nodejs22.x');
  });

  it('Test 2: Lambda has ses:SendRawEmail on tale-forge.app SES identity', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const senderPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('EmailSender'),
    );
    const serialised = JSON.stringify(senderPolicies);
    expect(serialised).toContain('ses:SendRawEmail');
    expect(serialised).toContain('identity/tale-forge.app');
    // ses:* / ses:SendEmail must NOT be granted — only SendRawEmail.
    expect(serialised).not.toMatch(/"ses:\*"/);
    expect(serialised).not.toContain('ses:SendEmail"');
  });

  it('Test 3: Lambda has rds-db:connect as kos_email_sender (NOT kos_admin)', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const senderPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('EmailSender'),
    );
    const serialised = JSON.stringify(senderPolicies);
    expect(serialised).toContain('rds-db:connect');
    expect(serialised).toContain('kos_email_sender');
    expect(serialised).not.toContain('dbuser:prx-fake/kos_admin');
    expect(serialised).not.toContain('dbuser:prx-fake/kos_agent_writer');
  });

  it('Test 4: Lambda has events:PutEvents on kos.output', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const senderPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('EmailSender'),
    );
    const serialised = JSON.stringify(senderPolicies);
    expect(serialised).toContain('events:PutEvents');
    expect(serialised.toLowerCase()).toContain('outputbus');
  });

  it('Test 5: SAFETY — Lambda role has NO bedrock:* permissions', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const senderPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('EmailSender'),
    );
    const serialised = JSON.stringify(senderPolicies);
    // Hard negative — any "bedrock:" substring is a structural failure of
    // the Approve-gate threat model (T-04-SENDER-01).
    expect(serialised).not.toMatch(/"bedrock:/);
  });

  it('Test 6: EventBridge rule on kos.output / email.approved targets EmailSender', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['kos.output'],
          'detail-type': ['email.approved'],
        }),
      }),
    );
    // Find the rule and assert its target is the EmailSender function.
    const rules = tpl.findResources('AWS::Events::Rule');
    const approvedRule = Object.values(rules).find((r) => {
      const ev = (r as { Properties: { EventPattern?: { 'detail-type'?: string[] } } })
        .Properties.EventPattern;
      return ev?.['detail-type']?.includes('email.approved');
    });
    expect(approvedRule).toBeDefined();
    const targets = (approvedRule as {
      Properties: { Targets: Array<{ Arn: unknown }> };
    }).Properties.Targets;
    expect(targets.length).toBeGreaterThanOrEqual(1);
    // Target ARN should reference the EmailSender Lambda's GetAtt.
    const targetArnStr = JSON.stringify(targets);
    expect(targetArnStr).toContain('EmailSender');
  });
});
