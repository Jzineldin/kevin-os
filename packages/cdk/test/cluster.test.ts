import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';

/**
 * KosCluster (ECS Fargate) synth-level assertions (INF-06).
 *
 * Phase 1 scope: empty cluster. No task definitions, no services.
 * Services (EmailEngine Phase 4, Baileys Phase 5, Postiz Phase 8) will
 * reference `DataStack.ecsCluster` at attach time.
 */
describe('ECS Fargate cluster', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const tpl = Template.fromStack(data);

  it('creates exactly one ECS cluster', () => {
    tpl.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  it('cluster is named kos-cluster', () => {
    tpl.hasResourceProperties(
      'AWS::ECS::Cluster',
      Match.objectLike({ ClusterName: 'kos-cluster' }),
    );
  });

  it('DataStack exposes the cluster via public readonly ecsCluster', () => {
    expect(data.ecsCluster).toBeDefined();
    // clusterName is a CFN Token at synth time; assert it's defined and
    // that the CFN resource carries the desired ClusterName (covered above).
    expect(typeof data.ecsCluster.clusterArn).toBe('string');
  });

  it('no task definitions or services in Phase 1 (shell only)', () => {
    tpl.resourceCountIs('AWS::ECS::TaskDefinition', 0);
    tpl.resourceCountIs('AWS::ECS::Service', 0);
  });
});
