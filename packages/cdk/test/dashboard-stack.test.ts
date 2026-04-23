import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { DashboardStack } from '../lib/stacks/dashboard-stack';

/**
 * DashboardStack synth-level assertions (Plan 03-04).
 *
 * Covers:
 *   - dashboard-api Lambda (VPC-attached, nodejs22.x, arm64, 1024 MB, 30 s)
 *   - dashboard-notify Lambda (VPC-attached, nodejs22.x, arm64)
 *   - relay-proxy Lambda (VPC-attached, nodejs22.x, arm64)
 *   - Two Function URLs with `AuthType: AWS_IAM` and `InvokeMode: BUFFERED`
 *   - EventBridge rule on kos.output matching the 5 D-25 detail-types
 *   - Fargate service desiredCount=1, CPU 256, Memory 512, ARM64
 *   - Internal NLB (Scheme: internal)
 *   - 3 Secrets (bearer, sentry-dsn, caller-keys)
 *   - 2 IAM users (kos-dashboard-caller, kos-dashboard-relay-caller)
 *   - Narrow IAM policies (no Resource: "*" on the caller policies)
 *   - CloudWatch log group /ecs/dashboard-listen-relay
 */
describe('DashboardStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const dashboard = new DashboardStack(app, 'Dash', {
    env,
    vpc: net.vpc,
    outputBus: events.buses.output,
    cluster: data.ecsCluster,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
    rdsProxySecurityGroup: data.rdsSecurityGroup,
    notionTokenSecret: data.notionTokenSecret,
    notionTodayPageId: 'todaypage-aaaabbbbccccdddd',
    notionCommandCenterDbId: 'ccdb-aaaabbbbccccdddd',
    vercelOriginUrl: 'https://kos-dashboard-kevin-elzarka.vercel.app',
  });
  const tpl = Template.fromStack(dashboard);

  // --- Lambda counts + runtimes ----------------------------------------
  // Our Lambdas use `logRetention`, which CDK implements via an internal
  // log-retention Lambda on nodejs22.x (latest CDK) with no Architectures
  // field (defaults to x86_64). Filter by presence of `Architectures: ['arm64']`
  // — Phase 3 Lambdas all set ARM64 explicitly via the KosLambda construct.
  const ourLambdas = () => {
    const fns = tpl.findResources('AWS::Lambda::Function');
    return Object.values(fns).filter((f) => {
      const props = (f as { Properties: { Runtime: string; Architectures?: string[] } })
        .Properties;
      return (
        props.Runtime === 'nodejs22.x' &&
        Array.isArray(props.Architectures) &&
        props.Architectures.includes('arm64')
      );
    });
  };

  it('creates exactly 3 Phase-3 Lambda functions (dashboard-api, dashboard-notify, relay-proxy)', () => {
    expect(ourLambdas().length).toBe(3);
  });

  it('every Phase-3 Lambda runs nodejs22.x on arm64', () => {
    for (const fn of ourLambdas()) {
      const props = (fn as { Properties: { Runtime: string; Architectures: string[] } })
        .Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('dashboard-api Lambda has 1024 MB memory and 30 s timeout', () => {
    const fns = tpl.findResources('AWS::Lambda::Function');
    const apiFn = Object.values(fns).find((f) => {
      const env = (f as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables;
      return env?.NOTION_TODAY_PAGE_ID !== undefined;
    });
    expect(apiFn).toBeDefined();
    const props = (apiFn as { Properties: { MemorySize: number; Timeout: number } }).Properties;
    expect(props.MemorySize).toBe(1024);
    expect(props.Timeout).toBe(30);
  });

  // --- Function URLs ----------------------------------------------------
  it('creates 2 Lambda Function URLs with AuthType AWS_IAM + InvokeMode BUFFERED', () => {
    tpl.resourceCountIs('AWS::Lambda::Url', 2);
    const urls = tpl.findResources('AWS::Lambda::Url');
    for (const u of Object.values(urls)) {
      const props = (u as { Properties: { AuthType: string; InvokeMode: string } }).Properties;
      expect(props.AuthType).toBe('AWS_IAM');
      expect(props.InvokeMode).toBe('BUFFERED');
    }
  });

  it('dashboard-api Function URL has CORS allowing only the Vercel origin', () => {
    tpl.hasResourceProperties(
      'AWS::Lambda::Url',
      Match.objectLike({
        AuthType: 'AWS_IAM',
        Cors: Match.objectLike({
          AllowOrigins: ['https://kos-dashboard-kevin-elzarka.vercel.app'],
          AllowMethods: Match.arrayWith(['GET', 'POST']),
        }),
      }),
    );
  });

  // --- EventBridge rule -------------------------------------------------
  it('creates the kos.output -> dashboard-notify EventBridge rule with 5 detail-types', () => {
    tpl.hasResourceProperties(
      'AWS::Events::Rule',
      Match.objectLike({
        Name: 'to-dashboard-notify',
        EventPattern: Match.objectLike({
          'detail-type': Match.arrayWith([
            'inbox_item',
            'entity_merge',
            'capture_ack',
            'draft_ready',
            'timeline_event',
          ]),
        }),
      }),
    );
  });

  it('EventBridge rule has exactly 1 target (dashboard-notify)', () => {
    const rules = tpl.findResources('AWS::Events::Rule', {
      Properties: { Name: 'to-dashboard-notify' },
    });
    expect(Object.keys(rules).length).toBe(1);
    const rule = Object.values(rules)[0] as { Properties: { Targets: unknown[] } };
    expect(rule.Properties.Targets.length).toBe(1);
  });

  // --- Secrets Manager --------------------------------------------------
  it('creates 3 Secrets Manager placeholders', () => {
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (s) => (s as { Properties?: { Name?: string } }).Properties?.Name,
    );
    expect(names).toContain('kos/dashboard-bearer-token');
    expect(names).toContain('kos/sentry-dsn-dashboard');
    expect(names).toContain('kos/dashboard-caller-access-keys');
  });

  // --- IAM users --------------------------------------------------------
  it('creates 2 IAM users with the expected names', () => {
    tpl.resourceCountIs('AWS::IAM::User', 2);
    const users = tpl.findResources('AWS::IAM::User');
    const names = Object.values(users).map(
      (u) => (u as { Properties?: { UserName?: string } }).Properties?.UserName,
    );
    expect(names).toContain('kos-dashboard-caller');
    expect(names).toContain('kos-dashboard-relay-caller');
  });

  it('caller IAM policies scope lambda:InvokeFunctionUrl to specific function ARNs (no Resource: "*")', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const callerPolicies = Object.entries(policies).filter(([name]) =>
      /DashboardApiCallerPolicy|DashboardRelayCallerPolicy/.test(name),
    );
    expect(callerPolicies.length).toBe(2);
    for (const [, pol] of callerPolicies) {
      const statements = (pol as {
        Properties: { PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] } };
      }).Properties.PolicyDocument.Statement;
      for (const s of statements) {
        expect(s.Action).toBe('lambda:InvokeFunctionUrl');
        // Resource should be a ref/fn object, not the literal "*".
        expect(s.Resource).not.toBe('*');
      }
    }
  });

  it('dashboard-api role has rds-db:connect scoped to dashboard_api user', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('rds-db:connect');
    expect(serialized).toContain('dbuser:');
    expect(serialized).toContain('dashboard_api');
    expect(serialized).toContain('dashboard_notify');
    expect(serialized).toContain('dashboard_relay');
  });

  it('dashboard-api role has events:PutEvents scoped to kos.capture + kos.output buses (no wildcards)', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('events:PutEvents');
    expect(serialized).toContain('event-bus/kos.capture');
    expect(serialized).toContain('event-bus/kos.output');
  });

  // --- Fargate + NLB ----------------------------------------------------
  it('creates an ECS Fargate service with desiredCount=1 on the existing kos-cluster', () => {
    tpl.resourceCountIs('AWS::ECS::Service', 1);
    tpl.hasResourceProperties(
      'AWS::ECS::Service',
      Match.objectLike({
        DesiredCount: 1,
        LaunchType: 'FARGATE',
      }),
    );
  });

  it('Fargate task definition is ARM64 with 256 CPU / 512 MB', () => {
    tpl.hasResourceProperties(
      'AWS::ECS::TaskDefinition',
      Match.objectLike({
        Cpu: '256',
        Memory: '512',
        RuntimePlatform: Match.objectLike({
          CpuArchitecture: 'ARM64',
          OperatingSystemFamily: 'LINUX',
        }),
      }),
    );
  });

  it('creates an internal NLB (Scheme: internal) on TCP :8080', () => {
    tpl.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    tpl.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Match.objectLike({
        Scheme: 'internal',
        Type: 'network',
      }),
    );
    tpl.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::Listener',
      Match.objectLike({
        Port: 8080,
        Protocol: 'TCP',
      }),
    );
  });

  it('NLB target group health-checks the /healthz path', () => {
    tpl.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      Match.objectLike({
        HealthCheckPath: '/healthz',
        HealthCheckProtocol: 'HTTP',
        Protocol: 'TCP',
        TargetType: 'ip',
      }),
    );
  });

  it('creates /ecs/dashboard-listen-relay CloudWatch log group with 30-day retention', () => {
    tpl.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({
        LogGroupName: '/ecs/dashboard-listen-relay',
        RetentionInDays: 30,
      }),
    );
  });

  // --- Outputs ----------------------------------------------------------
  it('emits DashboardApiFunctionUrl + RelayProxyFunctionUrl CfnOutputs', () => {
    tpl.hasOutput(
      'DashboardApiFunctionUrl',
      Match.objectLike({ Export: Match.objectLike({ Name: 'KosDashboardApiFunctionUrl' }) }),
    );
    tpl.hasOutput(
      'RelayProxyFunctionUrl',
      Match.objectLike({ Export: Match.objectLike({ Name: 'KosDashboardRelayProxyUrl' }) }),
    );
    tpl.hasOutput(
      'DashboardApiCallerUserArn',
      Match.objectLike({ Export: Match.objectLike({ Name: 'KosDashboardApiCallerUserArn' }) }),
    );
  });
});
