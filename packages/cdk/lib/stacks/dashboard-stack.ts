/**
 * DashboardStack — Phase 3 Wave 1 compose point.
 *
 * Brings together:
 *  - dashboard-api Lambda (Function URL + AWS_IAM auth) — the single backend
 *    surface Vercel SigV4-signs against for all 10 REST routes (D-16..D-21).
 *  - dashboard-notify Lambda — consumes `kos.output` EventBridge events and
 *    executes `pg_notify(kos_output, …)` (D-22..D-25, pointer-only payload).
 *  - EventBridge rule on the `kos.output` bus matching the 5 D-25 detail-types
 *    and routing to dashboard-notify.
 *  - dashboard-listen-relay Fargate service (0.25 vCPU / 0.5 GB ARM64, single
 *    task) that holds `LISTEN kos_output` and exposes a long-poll `/events`
 *    endpoint (D-24).
 *  - relay-proxy Lambda (Option B ingress per RESEARCH §13) — a thin
 *    VPC-attached Function URL that forwards HTTP calls to the internal NLB
 *    in front of the Fargate task. Saves ~$21/month vs API Gateway + VPC Link.
 *  - IAM users `kos-dashboard-caller` + `kos-dashboard-relay-caller` with
 *    narrowly-scoped `lambda:InvokeFunctionUrl` policies (T-3-04-01).
 *  - Secrets Manager placeholders (`kos/dashboard-bearer-token`,
 *    `kos/sentry-dsn-dashboard`, `kos/dashboard-caller-access-keys`) — Kevin
 *    populates post-deploy via `scripts/sync-vercel-env.ts` (Plan 11).
 *
 * Depends on: NetworkStack (VPC), DataStack (RDS Proxy endpoint + SG + ECS
 * cluster), EventsStack (`kos.output` bus), IntegrationsStack (Notion token).
 */

import {
  Stack,
  type StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  FunctionUrlAuthType,
  InvokeMode,
  HttpMethod,
  type FunctionUrl,
} from 'aws-cdk-lib/aws-lambda';
import { Rule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as EventLambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { User, Policy, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  SecurityGroup,
  type IVpc,
  type ISecurityGroup,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import type { ICluster } from 'aws-cdk-lib/aws-ecs';
import { KosLambda } from '../constructs/kos-lambda.js';
import { buildRelayStack } from './integrations-dashboard.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function serviceEntry(service: string, file = 'index.ts'): string {
  return path.join(REPO_ROOT, 'services', service, 'src', file);
}

export interface DashboardStackProps extends StackProps {
  vpc: IVpc;
  outputBus: IEventBus;
  cluster: ICluster;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` identifier for IAM `rds-db:connect` resource ARN. */
  rdsProxyDbiResourceId: string;
  rdsProxySecurityGroup: ISecurityGroup;
  notionTokenSecret: ISecret;
  /**
   * Notion page ID that holds Kevin's 🏠 Today block. Sourced at synth time
   * from env var or CDK context; defaults to empty string so the stack
   * synthesizes in CI before the bootstrap ran.
   */
  notionTodayPageId: string;
  /** Notion DB ID for Command Center (Top-3 priorities source). */
  notionCommandCenterDbId: string;
  /**
   * Vercel origin for CORS — the browser Origin header for any direct calls
   * to the Function URL. Default: Vercel preview domain. Production swap is
   * a CDK context variable.
   */
  vercelOriginUrl: string;
}

/**
 * Output contract (see CfnOutputs at the end of this class):
 *
 *   DashboardApiFunctionUrl   — https://<id>.lambda-url.<region>.on.aws/
 *   RelayProxyFunctionUrl     — https://<id>.lambda-url.<region>.on.aws/
 *   DashboardApiCallerUserArn — arn:aws:iam::<acct>:user/kos-dashboard-caller
 *   DashboardRelayCallerUserArn — arn:aws:iam::<acct>:user/kos-dashboard-relay-caller
 *   FargateClusterName        — kos-cluster (existing, for info only)
 *
 * Plan 11 will read these outputs (via `aws cloudformation describe-stacks`)
 * to populate Vercel env vars.
 */
export class DashboardStack extends Stack {
  public readonly dashboardApiFunctionUrl: FunctionUrl;
  public readonly relayProxyFunctionUrl: string;
  public readonly apiCallerUser: User;
  public readonly relayCallerUser: User;

  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    // --- Security group: dashboard Lambdas -> RDS Proxy -------------------
    // NOTE: RDS Proxy in DataStack already has `allowFromAnyIpv4(:5432)` on
    // its SG (IAM auth is the gate). No cross-stack ingress rule needed —
    // adding one creates a DashboardStack -> DataStack -> DashboardStack
    // dependency cycle via SecurityGroup.GroupId tokens.
    const lambdaSg = new SecurityGroup(this, 'DashboardLambdaSG', {
      vpc: props.vpc,
      description:
        'dashboard-api + dashboard-notify egress to RDS Proxy and EventBridge',
      allowAllOutbound: true,
    });

    // --- Secrets Manager placeholders --------------------------------------
    // All three are seeded post-deploy (Kevin + Plan 11 rotation script).
    // removalPolicy: RETAIN — `cdk destroy` must never delete live secrets.
    const bearerSecret = new Secret(this, 'DashboardBearerSecret', {
      secretName: 'kos/dashboard-bearer-token',
      description:
        'Bearer token for Vercel cookie auth (D-19); populated post-deploy.',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    void bearerSecret;

    const sentrySecret = new Secret(this, 'SentryDsnDashboardSecret', {
      secretName: 'kos/sentry-dsn-dashboard',
      description:
        '@sentry/nextjs DSN for the Vercel dashboard app (D-40); populated post-deploy.',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    void sentrySecret;

    const callerKeysSecret = new Secret(this, 'DashboardCallerKeysSecret', {
      secretName: 'kos/dashboard-caller-access-keys',
      description:
        'IAM access keys (AccessKeyId + SecretAccessKey) for kos-dashboard-caller; ' +
        'populated by Plan 11 rotation script — stack creates the user, not the keys.',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    void callerKeysSecret;

    // --- dashboard-api Lambda ---------------------------------------------
    // Per P-04 (RESEARCH §17): inject Notion token value at deploy time to
    // avoid a Secrets Manager VPC interface endpoint (cost optimization).
    const notionTokenRef = Secret.fromSecretCompleteArn(
      this,
      'NotionTokenRef',
      props.notionTokenSecret.secretArn,
    );

    const dashboardApi = new KosLambda(this, 'DashboardApi', {
      entry: serviceEntry('dashboard-api'),
      timeout: Duration.seconds(30),
      memory: 1024,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        AWS_REGION_DASHBOARD: this.region,
        RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
        RDS_USER: 'dashboard_api',
        RDS_DATABASE: 'kos',
        NOTION_TOKEN: notionTokenRef.secretValue.unsafeUnwrap(),
        NOTION_TODAY_PAGE_ID: props.notionTodayPageId,
        NOTION_COMMAND_CENTER_DB_ID: props.notionCommandCenterDbId,
        KOS_CAPTURE_BUS: 'kos.capture',
        KOS_OUTPUT_BUS: props.outputBus.eventBusName,
      },
    });

    // IAM — rds-db:connect scoped to the `dashboard_api` Postgres user.
    dashboardApi.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['rds-db:connect'],
        resources: [
          `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${props.rdsProxyDbiResourceId}/dashboard_api`,
        ],
      }),
    );

    // IAM — events:PutEvents scoped to the two buses Phase 3 publishes to.
    dashboardApi.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['events:PutEvents'],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:event-bus/kos.capture`,
          `arn:aws:events:${this.region}:${this.account}:event-bus/kos.output`,
        ],
      }),
    );

    // Function URL — AUTH_IAM, BUFFERED (non-streaming JSON responses).
    const apiUrl = dashboardApi.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      invokeMode: InvokeMode.BUFFERED,
      cors: {
        allowedOrigins: [props.vercelOriginUrl],
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedHeaders: [
          'content-type',
          'authorization',
          'x-amz-date',
          'x-amz-security-token',
          'x-amz-content-sha256',
        ],
        maxAge: Duration.hours(1),
      },
    });
    this.dashboardApiFunctionUrl = apiUrl;

    // --- dashboard-notify Lambda -------------------------------------------
    const dashboardNotify = new KosLambda(this, 'DashboardNotify', {
      entry: serviceEntry('dashboard-notify'),
      timeout: Duration.seconds(10),
      memory: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        AWS_REGION_DASHBOARD: this.region,
        RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
        RDS_USER: 'dashboard_notify',
        RDS_DATABASE: 'kos',
      },
    });
    dashboardNotify.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['rds-db:connect'],
        resources: [
          `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${props.rdsProxyDbiResourceId}/dashboard_notify`,
        ],
      }),
    );

    // --- EventBridge rule: kos.output -> dashboard-notify -----------------
    // Hard-coded 5 detail-types per D-25; any drift must be an explicit
    // schema change in @kos/contracts/dashboard + CDK update.
    new Rule(this, 'KosOutputToDashboardNotify', {
      ruleName: 'to-dashboard-notify',
      eventBus: props.outputBus,
      eventPattern: {
        detailType: [
          'inbox_item',
          'entity_merge',
          'capture_ack',
          'draft_ready',
          'timeline_event',
        ],
      },
      targets: [new EventLambdaTarget(dashboardNotify)],
    });

    // --- Fargate relay + relay-proxy (Option B ingress) -------------------
    const relay = buildRelayStack(this, {
      vpc: props.vpc,
      cluster: props.cluster,
      rdsProxyEndpoint: props.rdsProxyEndpoint,
      rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
      rdsProxySecurityGroup: props.rdsProxySecurityGroup,
    });
    this.relayProxyFunctionUrl = relay.relayProxyUrl;

    // --- IAM users + caller policies --------------------------------------
    // kos-dashboard-caller -> can only invoke dashboard-api Function URL.
    this.apiCallerUser = new User(this, 'DashboardApiCaller', {
      userName: 'kos-dashboard-caller',
    });
    this.apiCallerUser.attachInlinePolicy(
      new Policy(this, 'DashboardApiCallerPolicy', {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['lambda:InvokeFunctionUrl'],
            resources: [dashboardApi.functionArn],
            conditions: {
              StringEquals: {
                'lambda:FunctionUrlAuthType': 'AWS_IAM',
              },
            },
          }),
        ],
      }),
    );

    // kos-dashboard-relay-caller -> can only invoke relay-proxy Function URL.
    this.relayCallerUser = new User(this, 'DashboardRelayCaller', {
      userName: 'kos-dashboard-relay-caller',
    });
    this.relayCallerUser.attachInlinePolicy(
      new Policy(this, 'DashboardRelayCallerPolicy', {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['lambda:InvokeFunctionUrl'],
            resources: [relay.relayProxyFunctionArn],
            conditions: {
              StringEquals: {
                'lambda:FunctionUrlAuthType': 'AWS_IAM',
              },
            },
          }),
        ],
      }),
    );

    // --- CfnOutputs (consumed by Plan 11 Vercel env sync) -----------------
    new CfnOutput(this, 'DashboardApiFunctionUrl', {
      value: apiUrl.url,
      description: 'Function URL for dashboard-api; Vercel SigV4-signs here.',
      exportName: 'KosDashboardApiFunctionUrl',
    });
    new CfnOutput(this, 'RelayProxyFunctionUrl', {
      value: relay.relayProxyUrl,
      description:
        'Function URL for dashboard-listen-relay proxy (Option B ingress).',
      exportName: 'KosDashboardRelayProxyUrl',
    });
    new CfnOutput(this, 'DashboardApiCallerUserArn', {
      value: this.apiCallerUser.userArn,
      description:
        'IAM user ARN for Vercel SigV4 caller (api); access keys generated manually post-deploy.',
      exportName: 'KosDashboardApiCallerUserArn',
    });
    new CfnOutput(this, 'DashboardRelayCallerUserArn', {
      value: this.relayCallerUser.userArn,
      description:
        'IAM user ARN for Vercel SigV4 caller (relay-proxy); access keys generated manually post-deploy.',
      exportName: 'KosDashboardRelayCallerUserArn',
    });
    new CfnOutput(this, 'FargateClusterName', {
      value: props.cluster.clusterName,
      description: 'Existing ECS cluster the relay Fargate service runs in.',
    });
    new CfnOutput(this, 'DashboardBearerSecretArn', {
      value: bearerSecret.secretArn,
      description:
        'Secrets Manager ARN for kos/dashboard-bearer-token; seed with `aws secretsmanager put-secret-value`.',
    });
  }
}
