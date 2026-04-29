/**
 * OpenclawBridgeStack — Phase B consolidation bridge.
 *
 * One thin Lambda (kos-openclaw-bridge) with its own Function URL that
 * OpenClaw-side skills invoke to read from RDS (entity_index, mention_events).
 * Replaces the duplicated memi SQLite store — single source of truth = RDS.
 *
 * Security model:
 *   - Function URL auth = AWS_IAM  (Kevin IAM user SigV4-signs requests)
 *   - + Bearer token in X-Bridge-Auth header (checked in code) — belt & braces
 *   - RDS user kos_openclaw_bridge with SELECT-only grants on:
 *     entity_index, mention_events, project_index, inbox_index, top3_membership
 *   - VPC-attached, reuses existing RDS Proxy SG
 *
 * Why a separate Lambda (not an endpoint on dashboard-api):
 *   - Isolated failure domain — deploying bridge can't break the dashboard.
 *   - Smaller attack surface — read-only, 3 endpoints, no Notion, no LLM.
 *   - Independent rotation — bearer token separate from dashboard-bearer.
 *
 * Bootstrapped manually 2026-04-29 via `kos-bridge-bootstrap` Lambda + CLI
 * zip upload (see `scripts/phase-b/README.md`) — dev EC2 initially OOM'd on
 * full `cdk synth`; subsequent upsize (48GB→200GB EBS on 2026-04-26 + 15GB
 * RAM confirmed 2026-04-29) resolves that. This stack is wired into
 * `bin/kos.ts` as `KosOpenclawBridge` for future reproducibility. Live
 * resources are NOT yet owned by CloudFormation — next adoption step is
 * `cdk import KosOpenclawBridge` rather than `cdk deploy` (which would
 * create duplicates).
 */

import {
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  FunctionUrlAuthType,
  InvokeMode,
  type FunctionUrl,
} from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  SecurityGroup,
  type IVpc,
  type ISecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface OpenclawBridgeStackProps extends StackProps {
  vpc: IVpc;
  rdsProxyEndpoint: string;
  rdsProxySecurityGroup: ISecurityGroup;
  /** `KEVIN_OWNER_ID` — canonical owner UUID for row-level scoping. */
  kevinOwnerId: string;
  /**
   * Pre-existing secret holding the bearer token (set manually 2026-04-29).
   * Stack only references + grants access; doesn't create/rotate.
   */
  bridgeBearerSecret: ISecret;
  /**
   * Pre-existing DB credential secret for kos_openclaw_bridge role (SELECT-only).
   */
  bridgeDbSecret: ISecret;
}

export class OpenclawBridgeStack extends Stack {
  public readonly bridgeFunctionUrl: FunctionUrl;

  constructor(scope: Construct, id: string, props: OpenclawBridgeStackProps) {
    super(scope, id, props);

    const lambdaSg = new SecurityGroup(this, 'BridgeLambdaSG', {
      vpc: props.vpc,
      description: 'kos-openclaw-bridge egress to RDS Proxy',
      allowAllOutbound: true,
    });

    const bridge = new KosLambda(this, 'OpenclawBridge', {
      entry: path.join(REPO_ROOT, 'services', 'openclaw-bridge', 'src', 'handler.ts'),
      memory: 256,
      timeout: Duration.seconds(15),
      vpc: props.vpc,
      securityGroups: [lambdaSg],
      environment: {
        KEVIN_OWNER_ID: props.kevinOwnerId,
        BRIDGE_BEARER_SECRET_ARN: props.bridgeBearerSecret.secretArn,
        DB_SECRET_ARN: props.bridgeDbSecret.secretArn,
        RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
        RDS_DATABASE: 'kos',
        RDS_USER: 'kos_openclaw_bridge',
      },
    });

    props.bridgeBearerSecret.grantRead(bridge);
    props.bridgeDbSecret.grantRead(bridge);

    // Function URL with AWS_IAM — belt & braces with code-level Bearer check
    this.bridgeFunctionUrl = bridge.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      invokeMode: InvokeMode.BUFFERED,
    });

    new CfnOutput(this, 'BridgeFunctionUrl', {
      value: this.bridgeFunctionUrl.url,
      description: 'OpenClaw-facing bridge URL (SigV4 + Bearer required)',
    });
  }
}
