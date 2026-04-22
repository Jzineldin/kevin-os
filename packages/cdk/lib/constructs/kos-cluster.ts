import { Construct } from 'constructs';
import { Cluster, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';

export interface KosClusterProps {
  vpc: IVpc;
}

/**
 * KosCluster — empty ECS Fargate cluster.
 *
 * Phase 1 scope: cluster shell only. Services that will attach here:
 *   - Phase 4: EmailEngine (1 vCPU × 2 GB ARM64, single task, IMAP IDLE)
 *   - Phase 5: Baileys WhatsApp gateway (1 vCPU × 2 GB ARM64, single task)
 *   - Phase 8: Postiz (0.5 vCPU × 1 GB ARM64, single task)
 *
 * Design notes (INF-06):
 *   - Platform version 1.4.0 and ARM64 CPU architecture are declared on each
 *     FargateService / FargatePlatformVersion at attach time, NOT at cluster
 *     level — the cluster itself has no CPU architecture.
 *   - `containerInsightsV2: DISABLED` for Phase 1 to avoid CloudWatch Logs
 *     spend on an empty cluster. Revisit when the first service lands.
 *     (V2 is the non-deprecated form; the boolean `containerInsights` field
 *     is slated for removal in the next aws-cdk-lib major.)
 *   - Reusing the existing VPC (D-06): services will land in
 *     PRIVATE_ISOLATED subnets once they need RDS; any public-internet
 *     egress services (Phase 5 Baileys) will attach in public subnets with
 *     `assignPublicIp: true`.
 */
export class KosCluster extends Construct {
  public readonly cluster: Cluster;

  constructor(scope: Construct, id: string, props: KosClusterProps) {
    super(scope, id);

    this.cluster = new Cluster(this, 'Cluster', {
      clusterName: 'kos-cluster',
      vpc: props.vpc,
      containerInsightsV2: ContainerInsights.DISABLED,
    });
  }
}
