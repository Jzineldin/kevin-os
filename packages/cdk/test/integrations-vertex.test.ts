/**
 * Phase 6 Plan 06-05 INF-10 synth-level assertions for the Vertex
 * dossier-loader pipeline.
 *
 * Asserts:
 *   - DossierLoader Lambda exists with timeout 600s + memory 2048 MB.
 *   - EventBridge rule on kos.agent / context.full_dossier_requested exists
 *     and targets the Lambda.
 *   - Lambda env carries GCP_SA_JSON_SECRET_ARN + GCP_PROJECT_ID.
 *   - Lambda role has rds-db:connect (RDS Proxy IAM auth).
 *   - Lambda role grants GetSecretValue on the GCP SA secret.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — Vertex dossier-loader (Plan 06-05)', () => {
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
      scheduleGroupName: events.scheduleGroupName,
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
      // Plan 06-05 INF-10 — supply all three to activate the dossier pipeline.
      gcpVertexSaSecret: data.gcpVertexSaSecret,
      gcpProjectId: 'kos-vertex-prod',
      agentBus: events.buses.agent,
    });
    return { tpl: Template.fromStack(integrations) };
  }

  it('synthesises a DossierLoader Lambda with nodejs22.x + arm64; timeout 600s; memory 2048 MB', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const dossier = Object.entries(lambdas).find(([logicalId]) =>
      /^DossierLoader/.test(logicalId),
    );
    expect(dossier).toBeDefined();
    const props = (dossier![1] as { Properties: Record<string, unknown> }).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.Timeout).toBe(600);
    expect(props.MemorySize).toBe(2048);
  });

  it('DossierLoader env carries GCP_SA_JSON_SECRET_ARN + GCP_PROJECT_ID + RDS_PROXY_ENDPOINT', () => {
    const { tpl } = synth();
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const dossier = Object.entries(lambdas).find(([logicalId]) =>
      /^DossierLoader/.test(logicalId),
    );
    expect(dossier).toBeDefined();
    const env =
      ((dossier![1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties.Environment?.Variables) ?? {};
    expect(env).toHaveProperty('GCP_SA_JSON_SECRET_ARN');
    expect(env).toHaveProperty('GCP_PROJECT_ID');
    expect(env.GCP_PROJECT_ID).toBe('kos-vertex-prod');
    expect(env).toHaveProperty('RDS_PROXY_ENDPOINT');
    expect(env).toHaveProperty('DATABASE_HOST');
    expect(env).toHaveProperty('KEVIN_OWNER_ID');
  });

  it('EventBridge rule on kos.agent / context.full_dossier_requested targets the DossierLoader', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        EventPattern: Match.objectLike({
          source: ['kos.agent'],
          'detail-type': ['context.full_dossier_requested'],
        }),
      }),
    );
  });

  it('DossierLoader role has rds-db:connect on the RDS Proxy DBI', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dossierPolicies = Object.entries(policies).filter(([logicalId]) =>
      /DossierLoader/.test(logicalId),
    );
    expect(dossierPolicies.length).toBeGreaterThanOrEqual(1);
    const docs = dossierPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasRdsConnect = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      if (typeof action === 'string') return action === 'rds-db:connect';
      if (Array.isArray(action)) return action.includes('rds-db:connect');
      return false;
    });
    expect(hasRdsConnect).toBe(true);
  });

  it('DossierLoader role has secretsmanager:GetSecretValue on the GCP SA secret', () => {
    const { tpl } = synth();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const dossierPolicies = Object.entries(policies).filter(([logicalId]) =>
      /DossierLoader/.test(logicalId),
    );
    const docs = dossierPolicies.map(
      ([, p]) =>
        ((p as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } } })
          .Properties.PolicyDocument.Statement),
    );
    const flat = docs.flat();
    const hasSecretsRead = flat.some((s) => {
      const action = (s as { Action?: unknown }).Action;
      const actionList: string[] = typeof action === 'string'
        ? [action]
        : Array.isArray(action)
          ? (action as string[])
          : [];
      return actionList.some((a) => /secretsmanager:GetSecretValue/i.test(String(a)));
    });
    expect(hasSecretsRead).toBe(true);
  });

  it('dossier pipeline is OPTIONAL — synth without gcpVertexSaSecret omits the Lambda', () => {
    const app = new App();
    const net = new NetworkStack(app, 'N2', { env });
    const events = new EventsStack(app, 'E2', { env });
    const data = new DataStack(app, 'D2', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const integrations = new IntegrationsStack(app, 'I2', {
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
      scheduleGroupName: events.scheduleGroupName,
      kevinOwnerId: '00000000-0000-0000-0000-000000000001',
      sentryDsnSecret: data.sentryDsnSecret,
      langfusePublicKeySecret: data.langfusePublicSecret,
      langfuseSecretKeySecret: data.langfuseSecretSecret,
      // gcpVertexSaSecret/gcpProjectId/agentBus omitted — pipeline must skip.
    });
    const tpl = Template.fromStack(integrations);
    const lambdas = tpl.findResources('AWS::Lambda::Function');
    const dossier = Object.entries(lambdas).find(([logicalId]) =>
      /^DossierLoader/.test(logicalId),
    );
    expect(dossier).toBeUndefined();
  });
});
