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
      // D-05 revision (2026-04-22, Wave 5 live discovery): the original
      // `natGateways: 0` decision broke any Lambda that needed BOTH RDS
      // (requires VPC placement) AND external APIs (Bedrock / Notion /
      // Telegram / Sentry / Langfuse — require internet egress). Phase 1's
      // notion-indexer was silently failing every 5-min schedule for the
      // same reason. Single NAT gateway (~$32/mo + data) restores egress
      // for everything in the private subnet. Multi-AZ NAT can be added
      // later if availability becomes a concern.
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        // 'private' kept as PRIVATE_ISOLATED for RDS + bastion (no egress
        // needed; existing SG self-referencing trust model unchanged).
        { name: 'private', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        // 'lambda' = PRIVATE_WITH_EGRESS — pairs with the NAT above so
        // Lambdas can reach Bedrock / Notion / Telegram / Sentry / Langfuse
        // while staying inside the VPC for RDS Proxy access.
        { name: 'lambda', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
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
