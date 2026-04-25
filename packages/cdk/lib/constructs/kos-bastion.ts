import { Construct } from 'constructs';
import {
  BastionHostLinux,
  InstanceType,
  InstanceClass,
  InstanceSize,
  type IVpc,
  SubnetType,
  type ISecurityGroup,
  Port,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';

export interface KosBastionProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
}

/**
 * KosBastion — short-lived SSM-only bastion for in-VPC psql access during
 * Phase 1 bootstrap (Task 3) and one-off RDS maintenance.
 *
 * - No public IP, no SSH key — access is SSM Session Manager + IAM only.
 * - t4g.nano to minimise cost during the minutes it lives.
 * - Adds a single ingress rule on the RDS security group (port 5432) from
 *   the bastion's auto-generated SG.
 *
 * Gated by CDK context (`--context bastion=true`) in DataStack so the host
 * is provisioned only when needed; a follow-up `cdk deploy` without the flag
 * tears it down (threat T-01-BASTION-01 mitigation).
 */
export class KosBastion extends Construct {
  public readonly host: BastionHostLinux;

  constructor(scope: Construct, id: string, props: KosBastionProps) {
    super(scope, id);

    this.host = new BastionHostLinux(this, 'Host', {
      vpc: props.vpc,
      // PRIVATE_WITH_EGRESS so SSM agent can reach the SSM control plane via
      // NAT (no SSM VPC endpoints on this VPC). Without egress, the agent
      // never registers and `aws ssm start-session` errors with
      // TargetNotConnected.
      subnetSelection: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
    });

    // Explicitly attach SSM core policy. BastionHostLinux is documented to
    // attach this by default, but in aws-cdk-lib 2.248.0 on eu-north-1 the
    // attachment did NOT happen (reproduced 2026-04-22: role had zero attached
    // policies). Adding explicitly guarantees SSM Session Manager works.
    this.host.instance.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    const bastionSg = this.host.connections.securityGroups[0];
    if (!bastionSg) {
      throw new Error('BastionHostLinux did not expose a default security group');
    }
    props.rdsSecurityGroup.addIngressRule(bastionSg, Port.tcp(5432), 'bastion psql');
  }
}
