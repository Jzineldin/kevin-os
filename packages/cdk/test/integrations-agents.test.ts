/**
 * AGT-04 gap closure: Azure Search wiring on consumer Lambdas (Plan 06-07).
 *
 * Asserts that when `azureSearchAdminSecret` is passed to
 * wireTriageAndVoiceCapture, all 4 consumer Lambdas (triage, voice-capture,
 * entity-resolver, transcript-extractor) receive AZURE_SEARCH_ADMIN_SECRET_ARN
 * + AZURE_SEARCH_INDEX_NAME env vars; and when the prop is absent, no Lambda
 * receives those env vars (backward-compat for pre-gap fixtures).
 */
import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Vpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { wireTriageAndVoiceCapture } from '../lib/stacks/integrations-agents.js';

describe('AGT-04 gap closure: Azure Search wiring on consumer Lambdas (Plan 06-07)', () => {
  it('injects AZURE_SEARCH_ADMIN_SECRET_ARN + AZURE_SEARCH_INDEX_NAME into all 4 consumer Lambdas when azureSearchAdminSecret prop is set', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'eu-north-1' } });
    const vpc = new Vpc(stack, 'V');
    const sg = new SecurityGroup(stack, 'Sg', { vpc });
    const bus = (n: string) => new EventBus(stack, n, { eventBusName: n });
    const secret = (n: string) => new Secret(stack, n);
    wireTriageAndVoiceCapture(stack, {
      captureBus: bus('cap'),
      triageBus: bus('tri'),
      agentBus: bus('agt'),
      outputBus: bus('out'),
      notionTokenSecret: secret('notion'),
      sentryDsnSecret: secret('sentry'),
      langfusePublicSecret: secret('lfp'),
      langfuseSecretSecret: secret('lfs'),
      azureSearchAdminSecret: secret('azs'),
      rdsProxyEndpoint: 'fake.rds',
      rdsIamUser: 'kos_admin',
      rdsProxyDbiResourceId: 'prx-fake',
      kevinOwnerId: '00000000-0000-0000-0000-000000000000',
      vpc,
      rdsSecurityGroup: sg,
    });
    const t = Template.fromStack(stack);

    const lambdas = t.findResources('AWS::Lambda::Function');
    const consumerLambdaCount = Object.values(lambdas).filter(
      (l: any) =>
        l.Properties?.Environment?.Variables?.AZURE_SEARCH_ADMIN_SECRET_ARN !== undefined,
    ).length;
    // 4 consumer Lambdas (triage, voice-capture, entity-resolver, transcript-extractor)
    // must each have the env var. Bulk-import Lambdas don't call loadContext.
    expect(consumerLambdaCount).toBeGreaterThanOrEqual(4);

    // Sanity check the index name default also flows through.
    const indexNameCount = Object.values(lambdas).filter(
      (l: any) =>
        l.Properties?.Environment?.Variables?.AZURE_SEARCH_INDEX_NAME === 'kos-memory',
    ).length;
    expect(indexNameCount).toBeGreaterThanOrEqual(4);
  });

  it('omits Azure env vars when azureSearchAdminSecret prop is absent (backward compat)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStackBC', { env: { account: '123456789012', region: 'eu-north-1' } });
    const vpc = new Vpc(stack, 'V');
    const sg = new SecurityGroup(stack, 'Sg', { vpc });
    const bus = (n: string) => new EventBus(stack, n, { eventBusName: n });
    const secret = (n: string) => new Secret(stack, n);
    wireTriageAndVoiceCapture(stack, {
      captureBus: bus('cap'),
      triageBus: bus('tri'),
      agentBus: bus('agt'),
      outputBus: bus('out'),
      notionTokenSecret: secret('notion'),
      sentryDsnSecret: secret('sentry'),
      langfusePublicSecret: secret('lfp'),
      langfuseSecretSecret: secret('lfs'),
      // azureSearchAdminSecret intentionally omitted (backward compat)
      rdsProxyEndpoint: 'fake.rds',
      rdsIamUser: 'kos_admin',
      rdsProxyDbiResourceId: 'prx-fake',
      kevinOwnerId: '00000000-0000-0000-0000-000000000000',
      vpc,
      rdsSecurityGroup: sg,
    });
    const t = Template.fromStack(stack);
    const lambdas = t.findResources('AWS::Lambda::Function');
    const lambdasWithAzureEnv = Object.values(lambdas).filter(
      (l: any) =>
        l.Properties?.Environment?.Variables?.AZURE_SEARCH_ADMIN_SECRET_ARN !== undefined,
    ).length;
    expect(lambdasWithAzureEnv).toBe(0);
  });
});
