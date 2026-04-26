/**
 * Plan 08-05 Task 2 synth-level assertions for the document-diff
 * pipeline.
 *
 * Asserts (6 tests):
 *   1. DocumentDiff Lambda exists with memory=1024, timeout=120s, nodejs22, arm64
 *   2. Lambda role has bedrock:InvokeModel pinned to Haiku 4.5 EU (NOT Sonnet)
 *   3. Lambda role has S3 read on the kos-blobs bucket (no PutObject grants)
 *   4. Lambda role has rds-db:connect on the kos_document_diff DB user
 *   5. EventBridge rule on kos.output / email.sent targets the Lambda
 *   6. SAFETY: Lambda role has zero postiz:* / ses:* / notion-write actions
 *
 * Reference:
 *   .planning/phases/08-outbound-content-calendar/08-05-PLAN.md §threat_model
 *   packages/cdk/lib/stacks/integrations-document-diff.ts
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — document-diff (Plan 08-05)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth() {
    const app = new App();
    const net = new NetworkStack(app, 'N', { env });
    const events = new EventsStack(app, 'E', { env });
    const data = new DataStack(app, 'D', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const integrations = new IntegrationsStack(app, 'I', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      captureBus: events.buses.capture,
      systemBus: events.buses.system,
      outputBus: events.buses.output,
      scheduleGroupName: events.scheduleGroupName,
      blobsBucket: data.blobsBucket,
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('1. DocumentDiff Lambda exists — nodejs22 + arm64; timeout 120s; memory 1024', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const found = Object.entries(lambdas).find(([logicalId]) =>
      /^DocumentDiff/.test(logicalId),
    );
    expect(found).toBeDefined();
    const props = (found![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Timeout).toBe(120);
    expect(props.MemorySize).toBe(1024);
  });

  it('2. Lambda role has bedrock:InvokeModel on Haiku 4.5 EU profile only (NOT Sonnet)', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dpolicies = Object.entries(policies).filter(([logicalId]) =>
      /DocumentDiff/.test(logicalId),
    );
    const docs = dpolicies.flatMap(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<unknown> } } })
          .Properties.PolicyDocument.Statement),
    );
    const bedrockStmt = docs.find((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return /bedrock:InvokeModel/.test(action);
      if (Array.isArray(action)) return action.some((a) => /bedrock:InvokeModel/.test(String(a)));
      return false;
    }) as { Resource?: unknown } | undefined;
    expect(bedrockStmt).toBeDefined();
    const resources = bedrockStmt!.Resource as string | string[];
    const resourceList = Array.isArray(resources) ? resources : [resources];
    const flatRes = resourceList.join('|');
    expect(flatRes).toMatch(/haiku-4-5/);
    // Must NOT grant Sonnet (or any non-Haiku FM).
    expect(flatRes).not.toMatch(/sonnet/i);
    expect(flatRes).not.toMatch(/opus/i);
  });

  it('3. Lambda role has s3:GetObject on the kos-blobs bucket', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dpolicies = Object.entries(policies).filter(([logicalId]) =>
      /DocumentDiff/.test(logicalId),
    );
    const docs = dpolicies.flatMap(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<unknown> } } })
          .Properties.PolicyDocument.Statement),
    );
    const hasS3Get = docs.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return /^s3:GetObject/.test(action);
      if (Array.isArray(action)) return action.some((a) => /^s3:GetObject/.test(String(a)));
      return false;
    });
    expect(hasS3Get).toBe(true);
  });

  it('4. Lambda role has rds-db:connect as kos_document_diff', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dpolicies = Object.entries(policies).filter(([logicalId]) =>
      /DocumentDiff/.test(logicalId),
    );
    const docs = dpolicies.flatMap(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<unknown> } } })
          .Properties.PolicyDocument.Statement),
    );
    const rdsStmt = docs.find((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return action === 'rds-db:connect';
      if (Array.isArray(action)) return action.includes('rds-db:connect');
      return false;
    }) as { Resource?: unknown } | undefined;
    expect(rdsStmt).toBeDefined();
    const resourceJson = JSON.stringify(rdsStmt!.Resource);
    expect(resourceJson).toContain('kos_document_diff');
  });

  it('5. EventBridge rule on kos.output / email.sent targets the Lambda', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['kos.output'],
          'detail-type': ['email.sent'],
        }),
      }),
    );
    // Find the rule + assert it has at least one target whose Arn references DocumentDiff.
    const rules = tpl.findResources('AWS::Events::Rule');
    const diffRule = Object.entries(rules).find(([, r]) => {
      const ep = (r as { Properties: { EventPattern?: { 'detail-type'?: string[] } } }).Properties
        .EventPattern;
      return Array.isArray(ep?.['detail-type']) && ep['detail-type'].includes('email.sent');
    });
    expect(diffRule).toBeDefined();
    const targetsRaw = (diffRule![1] as { Properties: { Targets: Array<unknown> } }).Properties
      .Targets;
    const targetJson = JSON.stringify(targetsRaw);
    expect(targetJson).toMatch(/DocumentDiff/);
  });

  it('6. SAFETY — Lambda role has zero postiz:* / ses:* / notion-write actions', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dpolicies = Object.entries(policies).filter(([logicalId]) =>
      /DocumentDiff/.test(logicalId),
    );
    const docs = dpolicies.flatMap(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<unknown> } } })
          .Properties.PolicyDocument.Statement),
    );
    const allActions = docs.flatMap((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return [action];
      if (Array.isArray(action)) return action.map((a) => String(a));
      return [] as string[];
    });
    expect(allActions.some((a) => /^postiz:/.test(a))).toBe(false);
    expect(allActions.some((a) => /^ses:/.test(a))).toBe(false);
    // No Notion-write IAM actions exist; this is a placeholder grep — we
    // never emit any IAM action with "notion" in the name. Guard against
    // future drift.
    expect(allActions.some((a) => /notion/i.test(a))).toBe(false);
    // Also assert no S3 PutObject (we want READ only).
    expect(allActions.some((a) => /^s3:Put/.test(a))).toBe(false);
    expect(allActions.some((a) => /^s3:Delete/.test(a))).toBe(false);
  });
});
