import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';

describe('NetworkStack', () => {
  const app = new App();
  const stack = new NetworkStack(app, 'TestNetwork', {
    env: { account: '123456789012', region: 'eu-north-1' },
  });
  const tpl = Template.fromStack(stack);

  it('creates exactly zero NAT Gateways (D-05)', () => {
    tpl.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('creates exactly one S3 Gateway Endpoint (D-06)', () => {
    tpl.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    // CDK emits ServiceName as a CloudFormation Fn::Join that resolves at deploy
    // time to `com.amazonaws.<region>.s3`. Assert on the Join structure to be
    // region-agnostic.
    tpl.hasResourceProperties(
      'AWS::EC2::VPCEndpoint',
      Match.objectLike({
        VpcEndpointType: 'Gateway',
        ServiceName: {
          'Fn::Join': [
            '',
            Match.arrayWith(['com.amazonaws.', '.s3']),
          ],
        },
      }),
    );
  });

  it('spans 2 AZs (2 public + 2 private isolated = 4 subnets)', () => {
    const subnets = tpl.findResources('AWS::EC2::Subnet');
    expect(Object.keys(subnets).length).toBe(4);
  });

  it('private subnets are isolated (no MapPublicIpOnLaunch)', () => {
    const isolated = tpl.findResources('AWS::EC2::Subnet', {
      Properties: {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'aws-cdk:subnet-type', Value: 'Isolated' }),
        ]),
      },
    });
    expect(Object.keys(isolated).length).toBeGreaterThanOrEqual(2);
    for (const subnet of Object.values(isolated)) {
      const props = (subnet as { Properties: { MapPublicIpOnLaunch?: boolean } }).Properties;
      expect(props.MapPublicIpOnLaunch).not.toBe(true);
    }
  });

  it('uses the 10.40.0.0/16 CIDR block', () => {
    tpl.hasResourceProperties(
      'AWS::EC2::VPC',
      Match.objectLike({ CidrBlock: '10.40.0.0/16' }),
    );
  });
});
