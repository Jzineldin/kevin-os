/**
 * Postiz Fargate wiring (Phase 8 AGT-08 / CAP-09 backing service).
 *
 * Scaffold: skeleton signature only. Full body lands in Plan 08-03.
 *
 * Design per CLAUDE.md + 08-CONTEXT.md D-03:
 *   - 0.5 vCPU × 1 GB ARM64 FargatePlatformVersion.VERSION1_4
 *   - Single task (desiredCount=1); Postiz is NOT horizontally scalable
 *   - EFS volume at /app/data for PostgreSQL + media
 *   - Cloud Map DNS `postiz.kos.local:3000` (reuses Phase 1 private namespace)
 *   - Secret `kos/postiz-api-key` for MCP authentication
 *   - No public endpoint; publisher Lambda calls via VPC-internal DNS
 *
 * Why a skeleton ships in Wave 0:
 *   - Plan 08-00 establishes the import surface for IntegrationsStack so
 *     Plans 08-03/08-04 can wire Postiz without re-doing the file-creation
 *     scaffolding. The skeleton does NOT register with IntegrationsStack
 *     yet — Plan 08-03 takes that step explicitly.
 *   - At runtime the skeleton throws so a partial deploy can never silently
 *     produce a Fargate service without the real config.
 */
import type { Construct } from 'constructs';
import type { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ICluster, FargateService } from 'aws-cdk-lib/aws-ecs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IFileSystem } from 'aws-cdk-lib/aws-efs';

export interface WirePostizFargateProps {
  vpc: IVpc;
  cluster: ICluster;
  rdsSecurityGroup: ISecurityGroup;
  /** kos/postiz-api-key (seeded by operator before deploy) */
  postizApiKeySecret: ISecret;
  /** kos/postiz-jwt-secret */
  postizJwtSecret: ISecret;
  /** Shared KOS EFS or Postiz-dedicated; mounted at /app/data */
  efs: IFileSystem;
}

export interface PostizFargateWiring {
  service: FargateService;
  /** Internal DNS name, e.g. 'postiz.kos.local:3000' */
  serviceDnsName: string;
}

export function wirePostizFargate(
  _scope: Construct,
  _props: WirePostizFargateProps,
): PostizFargateWiring {
  // Skeleton — full body in Plan 08-03.
  // Throws at runtime so a partial deploy fails loud rather than producing
  // a no-op Fargate service the operator might not notice.
  throw new Error(
    'wirePostizFargate skeleton — Plan 08-03 implements the body',
  );
}
