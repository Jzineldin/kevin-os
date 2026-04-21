import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  Vpc,
  IpAddresses,
  SubnetType,
  GatewayVpcEndpointAwsService,
  type IVpc,
  type IGatewayVpcEndpoint,
} from 'aws-cdk-lib/aws-ec2';

/**
 * NetworkStack — VPC + S3 Gateway Endpoint for Phase 1.
 *
 * Decisions enforced here:
 *  - D-05: `natGateways: 0` — no NAT in Phase 1. Lambdas that need the internet
 *    run outside the VPC; Lambdas that need RDS run inside `PRIVATE_ISOLATED`.
 *  - D-06: Only the S3 Gateway Endpoint is provisioned. Secrets Manager /
 *    Bedrock / EventBridge interface endpoints are deferred until measured
 *    cold-start or cost data justifies them.
 *
 * The `vpc` and `s3GatewayEndpoint` readonly properties are consumed directly
 * by DataStack (Plan 02) — cross-stack references travel as construct props,
 * not `Fn.importValue`, per RESEARCH Pattern 2.
 */
export class NetworkStack extends Stack {
  public readonly vpc: IVpc;
  public readonly s3GatewayEndpoint: IGatewayVpcEndpoint;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'KosVpc', {
      ipAddresses: IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2, // eu-north-1a + eu-north-1b; Multi-AZ RDS revisit post-Gate 4 (D-07)
      natGateways: 0, // D-05
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    // D-06: S3 Gateway Endpoint. Added as an explicit resource (not via the VPC
    // `gatewayEndpoints` prop) so DataStack (Plan 02) can reference
    // `s3GatewayEndpoint.vpcEndpointId` when writing the `aws:SourceVpce` bucket
    // policy condition (see RESEARCH Pitfall 2, lines 641-657).
    this.s3GatewayEndpoint = vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });
  }
}
