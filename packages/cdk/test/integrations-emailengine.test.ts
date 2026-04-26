/**
 * Plan 04-03 synth-level assertions for the EmailEngine Fargate + Redis +
 * 2-Lambda surface (CAP-07 / INF-06). Verifies:
 *   - Fargate task def: cpu=1024, memory=2048, ARM64 Linux.
 *   - Fargate service: desiredCount=1, minHealthy=0, maxHealthy=100
 *     (EmailEngine forbids horizontal scaling).
 *   - ElastiCache Serverless cache `kos-emailengine-redis`, redis 7+.
 *   - Redis SG ingress on :6379 from EE task SG only.
 *   - EE container env carries the 5 expected env vars + 3 ECS secrets.
 *   - emailengine-webhook Lambda Function URL: AuthType=NONE.
 *   - emailengine-admin Lambda Function URL: AuthType=AWS_IAM.
 *   - admin Lambda has GetSecretValue on the 3 EE-related secrets.
 *   - Cloud Map service `emailengine.kos-internal.local` registered.
 *   - Log group `/ecs/emailengine` 30-day retention.
 *   - Metric filter on `auth failure` exists.
 *   - Disabled by default — without enableEmailEngine no Fargate service
 *     synthesises (preserves existing tests + deploys).
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect, beforeAll } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

describe('IntegrationsStack — EmailEngine (Plan 04-03)', () => {
  const env = { account: '123456789012', region: 'eu-north-1' };

  function synth(opts: { enabled: boolean }) {
    const app = new App();
    const net = new NetworkStack(app, 'KosNetwork', { env });
    const events = new EventsStack(app, 'KosEvents', { env });
    const data = new DataStack(app, 'KosData', {
      env,
      vpc: net.vpc,
      s3Endpoint: net.s3GatewayEndpoint,
    });
    const integrations = new IntegrationsStack(app, 'KosIntegrations', {
      env,
      vpc: net.vpc,
      rdsSecurityGroup: data.rdsSecurityGroup,
      rdsSecret: data.rdsCredentialsSecret,
      rdsProxyEndpoint: data.rdsProxyEndpoint,
      rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
      notionTokenSecret: data.notionTokenSecret,
      azureSearchAdminSecret: data.azureSearchAdminSecret,
      blobsBucket: data.blobsBucket,
      captureBus: events.buses.capture,
      systemBus: events.buses.system,
      scheduleGroupName: events.scheduleGroupName,
      iosShortcutWebhookSecret: data.iosShortcutWebhookSecret,
      // EmailEngine wiring — gated on enableEmailEngine.
      enableEmailEngine: opts.enabled,
      ecsCluster: data.ecsCluster,
      emailEngineLicenseSecret: data.emailEngineLicenseSecret,
      emailEngineImapElzarkaSecret: data.emailEngineImapElzarkaSecret,
      emailEngineImapTaleforgeSecret: data.emailEngineImapTaleforgeSecret,
      emailEngineWebhookSecret: data.emailEngineWebhookSecret,
      emailEngineApiKeySecret: data.emailEngineApiKeySecret,
    });
    return { tpl: Template.fromStack(integrations), integrations };
  }

  // Cache one enabled synth + one disabled synth across all tests. Each synth
  // produces a multi-MB `cdk.out` directory under the test TMPDIR; running
  // 12 separate synths fills the host disk.
  let enabledTpl: Template;
  let disabledTpl: Template;
  let disabledIntegrations: IntegrationsStack;

  beforeAll(() => {
    const e = synth({ enabled: true });
    enabledTpl = e.tpl;
    const d = synth({ enabled: false });
    disabledTpl = d.tpl;
    disabledIntegrations = d.integrations;
  });

  it('disabled by default — no Fargate service or ElastiCache synthesised', () => {
    expect(disabledIntegrations.emailEngine).toBeUndefined();
    expect(Object.keys(disabledTpl.findResources('AWS::ECS::Service')).length).toBe(0);
    expect(
      Object.keys(disabledTpl.findResources('AWS::ElastiCache::ServerlessCache')).length,
    ).toBe(0);
  });

  it('Fargate task def: cpu=1024, memory=2048, ARM64 Linux', () => {
    const tpl = enabledTpl;
    tpl.hasResourceProperties(
      'AWS::ECS::TaskDefinition',
      Match.objectLike({
        Cpu: '1024',
        Memory: '2048',
        RuntimePlatform: Match.objectLike({
          CpuArchitecture: 'ARM64',
          OperatingSystemFamily: 'LINUX',
        }),
      }),
    );
  });

  it('Fargate service: desiredCount=1, minHealthy=0, maxHealthy=100', () => {
    const tpl = enabledTpl;
    tpl.hasResourceProperties(
      'AWS::ECS::Service',
      Match.objectLike({
        DesiredCount: 1,
        DeploymentConfiguration: Match.objectLike({
          MinimumHealthyPercent: 0,
          MaximumPercent: 100,
        }),
      }),
    );
  });

  it('creates ElastiCache Serverless cache kos-emailengine-redis on engine redis 7+', () => {
    const tpl = enabledTpl;
    tpl.hasResourceProperties(
      'AWS::ElastiCache::ServerlessCache',
      Match.objectLike({
        ServerlessCacheName: 'kos-emailengine-redis',
        Engine: 'redis',
        MajorEngineVersion: '7',
      }),
    );
  });

  it('Redis SG has ingress on :6379 from EmailEngine task SG only', () => {
    const tpl = enabledTpl;
    // Redis SG is `EmailEngineRedisSg`. Its ingress rules are emitted as
    // AWS::EC2::SecurityGroupIngress (or inline SecurityGroupIngress on the
    // SG resource); we accept either form and assert FromPort=6379 +
    // SourceSecurityGroupId references the EE task SG.
    const ingress = tpl.findResources('AWS::EC2::SecurityGroupIngress');
    const redisIngress = Object.values(ingress).find((r) => {
      const props = (r as { Properties: { FromPort?: number; ToPort?: number } })
        .Properties;
      return props.FromPort === 6379 && props.ToPort === 6379;
    });
    expect(redisIngress).toBeDefined();
    // Source SG token should reference the EmailEngine task SG (logical id
    // starts with `EmailEngineSg`).
    const serialised = JSON.stringify(redisIngress);
    expect(serialised).toMatch(/EmailEngineSg/);
  });

  it('EmailEngine container env carries the 5 expected literal env vars', () => {
    const tpl = enabledTpl;
    const taskDefs = tpl.findResources('AWS::ECS::TaskDefinition');
    const eeTd = Object.values(taskDefs).find((t) => {
      const containers = (
        t as {
          Properties?: {
            ContainerDefinitions?: Array<{ Image?: string; Name?: string }>;
          };
        }
      ).Properties?.ContainerDefinitions;
      return containers?.some(
        (c) => typeof c.Image === 'string' && c.Image.includes('emailengine'),
      );
    });
    expect(eeTd).toBeDefined();
    const containers = (
      eeTd as {
        Properties: {
          ContainerDefinitions: Array<{
            Environment?: Array<{ Name: string; Value: unknown }>;
            Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
          }>;
        };
      }
    ).Properties.ContainerDefinitions;
    const envEntries = containers[0]!.Environment ?? [];
    const envNames = envEntries.map((e) => e.Name);
    expect(envNames).toContain('EENGINE_PORT');
    expect(envNames).toContain('EENGINE_WORKERS');
    expect(envNames).toContain('EENGINE_LOG_LEVEL');
    expect(envNames).toContain('EENGINE_REDIS');
    expect(envNames).toContain('EENGINE_NOTIFY_URL');

    const secretNames = (containers[0]!.Secrets ?? []).map((s) => s.Name);
    expect(secretNames).toContain('EENGINE_LICENSE');
    expect(secretNames).toContain('EENGINE_API_KEY');
    expect(secretNames).toContain('EENGINE_NOTIFY_HEADERS_X_EE_SECRET');
  });

  it('emailengine-webhook Function URL has AuthType=NONE', () => {
    const tpl = enabledTpl;
    const urls = tpl.findResources('AWS::Lambda::Url');
    const webhookUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string; TargetFunctionArn: unknown } })
        .Properties;
      return (
        props.AuthType === 'NONE' &&
        JSON.stringify(props.TargetFunctionArn).includes('EmailEngineWebhook')
      );
    });
    expect(webhookUrl).toBeDefined();
  });

  it('emailengine-admin Function URL has AuthType=AWS_IAM', () => {
    const tpl = enabledTpl;
    const urls = tpl.findResources('AWS::Lambda::Url');
    const adminUrl = Object.values(urls).find((u) => {
      const props = (u as { Properties: { AuthType: string; TargetFunctionArn: unknown } })
        .Properties;
      return (
        props.AuthType === 'AWS_IAM' &&
        JSON.stringify(props.TargetFunctionArn).includes('EmailEngineAdmin')
      );
    });
    expect(adminUrl).toBeDefined();
  });

  it('admin Lambda has GetSecretValue on the 3 EE secrets (api-key + 2 imap)', () => {
    const tpl = enabledTpl;
    const policies = tpl.findResources('AWS::IAM::Policy');
    const adminPolicies = Object.entries(policies).filter(([name]) =>
      name.startsWith('EmailEngineAdmin'),
    );
    expect(adminPolicies.length).toBeGreaterThanOrEqual(1);
    const serialised = JSON.stringify(adminPolicies);
    expect(serialised).toContain('secretsmanager:GetSecretValue');
    // Secret references — secretName tokens carry the kos/emailengine-* path.
    expect(serialised).toMatch(/EmailEngineApiKey/);
    expect(serialised).toMatch(/EmailEngineImapKevinElzarka/);
    expect(serialised).toMatch(/EmailEngineImapKevinTaleforge/);
  });

  it('Cloud Map service emailengine.kos-internal.local registered', () => {
    const tpl = enabledTpl;
    tpl.hasResourceProperties(
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      Match.objectLike({ Name: 'kos-internal.local' }),
    );
    tpl.hasResourceProperties(
      'AWS::ServiceDiscovery::Service',
      Match.objectLike({ Name: 'emailengine' }),
    );
  });

  it('CloudWatch log group /ecs/emailengine 30-day retention + metric filter on auth failure', () => {
    const tpl = enabledTpl;
    tpl.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({
        LogGroupName: '/ecs/emailengine',
        RetentionInDays: 30,
      }),
    );
    tpl.hasResourceProperties(
      'AWS::Logs::MetricFilter',
      Match.objectLike({
        FilterPattern: Match.stringLikeRegexp('auth failure'),
        MetricTransformations: Match.arrayWith([
          Match.objectLike({
            MetricNamespace: 'KOS',
            MetricName: 'EmailEngineAuthFailures',
          }),
        ]),
      }),
    );
  });

  it('emits EmailEngineWebhookUrl + EmailEngineAdminUrl + EmailEngineRedisEndpoint outputs', () => {
    const tpl = enabledTpl;
    tpl.hasOutput('EmailEngineWebhookUrl', Match.anyValue());
    tpl.hasOutput('EmailEngineAdminUrl', Match.anyValue());
    tpl.hasOutput('EmailEngineRedisEndpoint', Match.anyValue());
  });
});
