import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

/**
 * Plan 01-05 synth-level assertions for the Azure Search bootstrap wiring.
 *
 * The live Azure PUT cannot be exercised at synth — that's what
 * `scripts/verify-azure-index.mjs` does against the deployed service. Here we
 * assert:
 *   - The CustomResource exists and references a Provider.
 *   - The bootstrap Lambda has AZURE_SEARCH_SECRET_ARN in its environment.
 *   - The schemaFingerprint is a deterministic hex digest (NOT a timestamp).
 */
describe('IntegrationsStack — Azure Search bootstrap', () => {
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
    });
    return { app, tpl: Template.fromStack(integrations) };
  }

  it('synthesises a CloudFormation CustomResource for the index', () => {
    const { tpl } = synth();
    // aws-cdk-lib/custom-resources Provider emits AWS::CloudFormation::CustomResource
    tpl.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('bootstrap Lambda carries AZURE_SEARCH_SECRET_ARN in its env', () => {
    const { tpl } = synth();
    // Find any Lambda whose env vars contain AZURE_SEARCH_SECRET_ARN.
    const fns = tpl.findResources('AWS::Lambda::Function');
    const matches = Object.values(fns).filter((fn) => {
      const vars = (
        fn as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      ).Properties?.Environment?.Variables;
      return vars !== undefined && 'AZURE_SEARCH_SECRET_ARN' in vars;
    });
    expect(matches.length).toBe(1);
  });

  it('schemaFingerprint on the CustomResource is a 64-char hex SHA-256 digest', () => {
    const { tpl } = synth();
    const resources = tpl.findResources('AWS::CloudFormation::CustomResource');
    const entry = Object.values(resources)[0] as {
      Properties?: { schemaFingerprint?: string };
    };
    const fp = entry.Properties?.schemaFingerprint;
    expect(fp).toBeDefined();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two consecutive synths produce the same schemaFingerprint (deterministic)', () => {
    const a = synth();
    const b = synth();
    const fpA = Object.values(
      a.tpl.findResources('AWS::CloudFormation::CustomResource'),
    )[0] as { Properties?: { schemaFingerprint?: string } };
    const fpB = Object.values(
      b.tpl.findResources('AWS::CloudFormation::CustomResource'),
    )[0] as { Properties?: { schemaFingerprint?: string } };
    expect(fpA.Properties?.schemaFingerprint).toBe(
      fpB.Properties?.schemaFingerprint,
    );
  });

  it('bootstrap Lambda has IAM permission to GetSecretValue on the admin secret', () => {
    const { tpl } = synth();
    tpl.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            }),
          ]),
        }),
      }),
    );
  });
});
