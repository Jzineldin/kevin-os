import { Stack, type StackProps, RemovalPolicy, Duration, Fn } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, Effect, AnyPrincipal, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  Port,
  SubnetType,
  type IVpc,
  type IGatewayVpcEndpoint,
  type SecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { DatabaseProxy, ProxyTarget, type DatabaseInstance } from 'aws-cdk-lib/aws-rds';
import type { Cluster } from 'aws-cdk-lib/aws-ecs';
import { KosRds } from '../constructs/kos-rds.js';
import { KosBastion } from '../constructs/kos-bastion.js';
import { KosCluster } from '../constructs/kos-cluster.js';

export interface DataStackProps extends StackProps {
  vpc: IVpc;
  s3Endpoint: IGatewayVpcEndpoint;
}

/**
 * DataStack — RDS Postgres 16.5 + pgvector, S3 blobs bucket (VPCe-scoped),
 * and four Secrets Manager placeholders seeded out-of-band.
 *
 * Decisions enforced here:
 *  - D-03: `RemovalPolicy.RETAIN` on bucket + secrets (RDS retained inside
 *    KosRds). `cdk destroy` cannot touch stateful resources.
 *  - D-07: RDS sizing / engine version inside KosRds.
 *  - INF-07: Secrets Manager holds (placeholder) NOTION_TOKEN_KOS,
 *    AZURE_SEARCH_ADMIN_KEY, TELEGRAM_BOT_TOKEN, KOS_DASHBOARD_BEARER.
 *    Values are populated by `scripts/seed-secrets.sh` interactively after
 *    first deploy; threat T-01-SECRET-01 mitigation.
 *  - RESEARCH Pitfall 2: bucket policy uses `aws:SourceVpce` (NOT
 *    `aws:SourceIp`) so Lambda-in-VPC traffic through the S3 Gateway Endpoint
 *    is allowed; internet traffic and other VPCe traffic are denied.
 *
 * The bastion is gated behind CDK context `bastion=true` so it's provisioned
 * only for Task 3's schema-push window; redeploy without the flag destroys
 * it (threat T-01-BASTION-01 mitigation).
 */
export class DataStack extends Stack {
  /**
   * Glob patterns (role-name portion of the IAM ARN) for Lambdas that live
   * OUTSIDE the VPC and are exempted from the `DenyAllExceptVpce` bucket
   * policy on `blobsBucket`. Exposed as a static so a CDK test can assert
   * each pattern matches a live role when all stacks synth together.
   *
   * Each entry is a `{StackName}-{LogicalId}*` CFN-generated role-name
   * pattern. See the inline comment in the constructor for rationale per
   * Lambda.
   */
  public static readonly VPCE_BYPASS_ROLE_PATTERNS: readonly string[] = [
    'KosCapture-TelegramBot*',
    'KosCapture-TranscribeStarter*',
    'KosCapture-TranscribeComplete*',
    // Phase 4 Plan 04-01 (CAP-02): ios-webhook Lambda lives in IntegrationsStack
    // and PUTs to `audio/*` on the blobs bucket from outside the VPC, same as
    // the Telegram bot. The plan-prescribed pattern was `KosEmailPipeline-*`,
    // but the helper is wired into IntegrationsStack rather than a dedicated
    // EmailPipeline stack — see 04-01-AGENT-NOTES for the deviation.
    'KosIntegrations-IosWebhook*',
  ];
  public readonly rds: DatabaseInstance;
  public readonly rdsCredentialsSecret: ISecret;
  public readonly rdsSecurityGroup: SecurityGroup;
  public readonly rdsProxy: DatabaseProxy;
  public readonly rdsProxyEndpoint: string;
  /**
   * The Proxy "DbiResourceId" — the `prx-xxxxxxxx` identifier used in the
   * IAM `rds-db:connect` resource ARN. Extracted from the Proxy's ARN at
   * synth time (`arn:aws:rds:region:account:db-proxy:prx-xxxxxxxx`).
   */
  public readonly rdsProxyDbiResourceId: string;
  public readonly blobsBucket: Bucket;
  public readonly ecsCluster: Cluster;
  public readonly notionTokenSecret: Secret;
  public readonly azureSearchAdminSecret: Secret;
  public readonly telegramBotTokenSecret: Secret;
  public readonly dashboardBearerSecret: Secret;
  // Phase 2 additions (D-25 observability, D-26 errors, CAP-01 webhook secret, D-23 ENT-06 sources).
  public readonly langfusePublicSecret: Secret;
  public readonly langfuseSecretSecret: Secret;
  public readonly sentryDsnSecret: Secret;
  public readonly telegramWebhookSecret: Secret;
  public readonly granolaApiKeySecret: Secret;
  public readonly gmailOauthSecret: Secret;
  // Phase 6 Plan 06-05: GCP Vertex AI service-account JSON for dossier-loader.
  public readonly gcpVertexSaSecret: Secret;
  // Phase 4 Plan 04-01 (CAP-02): shared HMAC secret for the iOS Shortcut
  // webhook. Operator seeds the real value via scripts/seed-secrets.sh
  // (`openssl rand -hex 32`) before pointing the iOS Shortcut at the
  // Function URL.
  public readonly iosShortcutWebhookSecret: Secret;
  // Phase 5 Plan 05-01 (CAP-04): chrome-webhook Bearer + HMAC secrets. The
  // chrome-webhook Lambda fetches BOTH on cold start and rejects empty /
  // 'PLACEHOLDER' values (T-05-01-01 fail-closed). Operator seeds via:
  //   aws secretsmanager put-secret-value \
  //     --secret-id kos/chrome-extension-bearer \
  //     --secret-string "$(openssl rand -hex 32)"
  //   aws secretsmanager put-secret-value \
  //     --secret-id kos/chrome-extension-hmac-secret \
  //     --secret-string "$(openssl rand -hex 32)"
  public readonly chromeExtensionBearerSecret: Secret;
  public readonly chromeExtensionHmacSecret: Secret;
  // Phase 4 Plan 04-03 (CAP-07 EmailEngine): five placeholder secrets for the
  // EmailEngine Fargate task + admin/webhook Lambdas. Operator seeds all five
  // out-of-band before `cdk deploy` activates the EmailEngine wiring (see
  // 04-EMAILENGINE-OPERATOR-RUNBOOK.md). EmailEngine forbids horizontal
  // scaling, so a single Fargate task reads these via ECS task-def secret
  // refs and the admin/webhook Lambdas read them via the Secrets Manager API.
  public readonly emailEngineLicenseSecret: Secret;
  public readonly emailEngineImapElzarkaSecret: Secret;
  public readonly emailEngineImapTaleforgeSecret: Secret;
  public readonly emailEngineWebhookSecret: Secret;
  public readonly emailEngineApiKeySecret: Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // --- RDS -----------------------------------------------------------------
    const rds = new KosRds(this, 'Rds', { vpc: props.vpc });
    this.rds = rds.instance;
    // KosRds uses `Credentials.fromGeneratedSecret`; `instance.secret` is
    // guaranteed to exist when credentials are generated by CDK.
    if (!rds.instance.secret) {
      throw new Error('KosRds instance did not expose a generated credentials secret');
    }
    this.rdsCredentialsSecret = rds.instance.secret;
    this.rdsSecurityGroup = rds.securityGroup;

    // --- RDS Proxy (Plan 04) -------------------------------------------------
    // T-01-PROXY-01: the Proxy enforces IAM auth; no password path is valid.
    // Lambdas outside the VPC reach the Proxy over its public endpoint, but
    // the only accepted credential is an IAM signed auth token (per
    // `rds-db:connect` on the Proxy's DbiResourceId). `allowFromAnyIpv4` is
    // accepted because egress IPs for out-of-VPC Lambdas are non-deterministic;
    // the alternative (putting the indexer in the VPC) would require a NAT
    // Gateway and violate D-05.
    const proxyRole = new Role(this, 'RdsProxyRole', {
      assumedBy: new ServicePrincipal('rds.amazonaws.com'),
    });
    this.rdsCredentialsSecret.grantRead(proxyRole);

    // Phase 3 dashboard roles — RDS Proxy needs one secret per Postgres role
    // it AS-authenticates. The migration 0011_dashboard_roles.sql consumes
    // the password from each secret to set the matching CREATE ROLE password.
    // removalPolicy: DESTROY is fine — passwords are auto-regenerated on
    // recreate and the migration's ALTER ROLE branch handles re-set.
    const dashboardRelayDbSecret = new Secret(this, 'DashboardRelayDbSecret', {
      secretName: 'kos/db/dashboard_relay',
      description: 'Postgres credentials for dashboard_relay role (RDS Proxy AS-auth).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dashboard_relay' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dashboardApiDbSecret = new Secret(this, 'DashboardApiDbSecret', {
      secretName: 'kos/db/dashboard_api',
      description: 'Postgres credentials for dashboard_api role (RDS Proxy AS-auth).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dashboard_api' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const dashboardNotifyDbSecret = new Secret(this, 'DashboardNotifyDbSecret', {
      secretName: 'kos/db/dashboard_notify',
      description: 'Postgres credentials for dashboard_notify role (RDS Proxy AS-auth).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dashboard_notify' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Phase 6+7 agent role — used by entity-timeline-refresher,
    // 4× azure-search-indexer-*, dossier-loader, granola-poller,
    // mv-refresher. The proxy needs a secret per IAM-authenticating
    // user; without it Lambdas hit "RDS proxy has no credentials for
    // the role kos_agent_writer" at runtime. Migration 0015 creates
    // the role and grants rds_iam.
    const agentWriterDbSecret = new Secret(this, 'AgentWriterDbSecret', {
      secretName: 'kos/db/kos_agent_writer',
      description: 'Postgres credentials for kos_agent_writer role (RDS Proxy AS-auth, Phase 6+7 IAM users).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'kos_agent_writer' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    dashboardRelayDbSecret.grantRead(proxyRole);
    dashboardApiDbSecret.grantRead(proxyRole);
    dashboardNotifyDbSecret.grantRead(proxyRole);
    agentWriterDbSecret.grantRead(proxyRole);

    this.rdsProxy = new DatabaseProxy(this, 'RdsProxy', {
      proxyTarget: ProxyTarget.fromInstance(rds.instance),
      secrets: [
        this.rdsCredentialsSecret,
        dashboardRelayDbSecret,
        dashboardApiDbSecret,
        dashboardNotifyDbSecret,
        agentWriterDbSecret,
      ],
      vpc: props.vpc,
      // Pin proxy to PRIVATE_ISOLATED only so adding new subnet types
      // (e.g. the PRIVATE_WITH_EGRESS 'lambda' subnets in 2026-04-22's
      // network refactor) doesn't trigger a CFN replacement on the
      // proxy's VpcSubnetIds set.
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      iamAuth: true,
      requireTLS: true,
      role: proxyRole,
      securityGroups: [this.rdsSecurityGroup],
    });
    // Proxy ingress from anywhere — IAM auth is the gate (documented in SUMMARY).
    this.rdsProxy.connections.allowFromAnyIpv4(Port.tcp(5432));
    this.rdsProxyEndpoint = this.rdsProxy.endpoint;

    // Extract `prx-xxxxxxxx` from Proxy ARN at synth time:
    //   arn:aws:rds:<region>:<account>:db-proxy:prx-xxxxxxxx
    // Fn.select(6, Fn.split(':', arn)) → 'db-proxy:prx-xxxxxxxx'
    // Fn.select(1, Fn.split('/', ...))  → 'prx-xxxxxxxx'  (note ARN uses ':')
    // Simpler: final ARN segment starts with 'prx-', split on ':' index 6.
    const lastArnSegment = Fn.select(6, Fn.split(':', this.rdsProxy.dbProxyArn));
    // Segment format: 'db-proxy:prx-xxxxxxxx' is actually ONE ':'-delimited
    // pair; CDK's dbProxyArn places the prx-id as the final ':' segment:
    // 'arn:aws:rds:REGION:ACCT:db-proxy:prx-ID'. So index 6 = 'prx-ID'.
    this.rdsProxyDbiResourceId = lastArnSegment;

    // --- Blobs bucket --------------------------------------------------------
    // Audio + transcripts + documents share one bucket with key prefixes
    // (Phase 2+ agents write `audio/`, `transcripts/`, `docs/`).
    this.blobsBucket = new Bucket(this, 'Blobs', {
      // CDK auto-names to avoid global-name collisions.
      bucketName: undefined,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });

    // Pitfall 2 mitigation: deny everything *except* traffic through the
    // S3 Gateway Endpoint. `aws:ViaAWSService=false` lets CloudFormation/AWS-
    // internal paths through during stack operations.
    //
    // Narrow exceptions (2026-04-23) — Lambdas that live OUTSIDE the VPC
    // but need to read/write specific prefixes of this bucket:
    //   (a) telegram-bot (D-05: intentionally outside VPC) — uploads user
    //       voice memos to `audio/*`.
    //   (b) transcribe-starter / transcribe-complete — start/finalise
    //       Amazon Transcribe jobs. Transcribe validates S3 access using
    //       the caller's identity at StartTranscriptionJob time, so the
    //       starter role needs bucket reach even though the actual read
    //       happens inside AWS. Both live outside the VPC.
    //
    // Each scope is narrow: the bot's grant is `audio/*` only; transcribe
    // roles are only granted read on audio/transcripts prefixes at the
    // resource-policy layer in integrations-transcribe-pipeline.ts.
    //
    // DRIFT RISK: These patterns use CloudFormation-generated role names
    // (`{StackName}-{LogicalId}*`). If a role is renamed, moved to a
    // different stack, or the stack prefix changes, the bypass silently
    // breaks. Guarded by a CDK test in test/data-stack-vpce-bypass.test.ts
    // that synthesises all stacks and asserts each bypass pattern matches
    // a live role.
    const vpceBypassRolePatterns = DataStack.VPCE_BYPASS_ROLE_PATTERNS;
    this.blobsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyAllExceptVpce',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:*'],
        resources: [this.blobsBucket.bucketArn, `${this.blobsBucket.bucketArn}/*`],
        conditions: {
          StringNotEquals: { 'aws:SourceVpce': props.s3Endpoint.vpcEndpointId },
          Bool: { 'aws:ViaAWSService': 'false' },
          ArnNotLike: {
            'aws:PrincipalArn': vpceBypassRolePatterns.map(
              (pattern) => `arn:aws:iam::${this.account}:role/${pattern}`,
            ),
          },
        },
      }),
    );

    // --- Secrets Manager placeholders ---------------------------------------
    // Values are seeded by scripts/seed-secrets.sh post-deploy; CDK creates
    // the entry shell only.
    const mkSecret = (constructId: string, name: string, description: string): Secret =>
      new Secret(this, constructId, {
        secretName: name,
        description,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.notionTokenSecret = mkSecret(
      'NotionToken',
      'kos/notion-token',
      'Notion integration token (Kevin workspace)',
    );
    this.azureSearchAdminSecret = mkSecret(
      'AzureAdminKey',
      'kos/azure-search-admin',
      'Azure AI Search admin API key',
    );
    this.telegramBotTokenSecret = mkSecret(
      'TelegramBotToken',
      'kos/telegram-bot-token',
      'Telegram Bot API token (Phase 2 consumer; placeholder now)',
    );
    this.dashboardBearerSecret = mkSecret(
      'DashboardBearer',
      'kos/dashboard-bearer',
      'Static Bearer token for Next.js dashboard (Phase 3 consumer)',
    );

    // --- Phase 2 secret shells -----------------------------------------------
    // Six additional placeholders land here so Wave 1+ Plan 02 agents + capture
    // handlers pull real values from Secrets Manager on cold start. Values are
    // seeded out-of-band via `scripts/seed-secrets.sh`; T-02-SECRETS-01
    // mitigation follows the same pattern as the 4 Phase-1 placeholders above.

    // D-25 Langfuse observability (OTel span export)
    this.langfusePublicSecret = mkSecret(
      'LangfusePublicKey',
      'kos/langfuse-public-key',
      'Langfuse cloud public key (D-25). Seeded via scripts/seed-secrets.sh.',
    );
    this.langfuseSecretSecret = mkSecret(
      'LangfuseSecretKey',
      'kos/langfuse-secret-key',
      'Langfuse cloud secret key (D-25).',
    );

    // D-26 Sentry error tracking
    this.sentryDsnSecret = mkSecret(
      'SentryDsn',
      'kos/sentry-dsn',
      'Sentry DSN for Lambda error tracking (D-26).',
    );

    // CAP-01 Telegram webhook secret_token (separate from bot token;
    // sent in X-Telegram-Bot-Api-Secret-Token header so we can reject forged posts).
    this.telegramWebhookSecret = mkSecret(
      'TelegramWebhookSecret',
      'kos/telegram-webhook-secret',
      'Telegram secret_token header value (T-02-WEBHOOK-01 mitigation).',
    );

    // D-23 ENT-06 Granola + Gmail bulk-import credentials
    this.granolaApiKeySecret = mkSecret(
      'GranolaApiKey',
      'kos/granola-api-key',
      'Granola REST API key for ENT-06 bulk import (D-23). Subject to Assumption A2.',
    );
    this.gmailOauthSecret = mkSecret(
      'GmailOauth',
      'kos/gmail-oauth-tokens',
      'Gmail OAuth client_id + client_secret + refresh_token JSON for ENT-06 (D-23).',
    );

    // Phase 6 Plan 06-05 (INF-10): GCP Vertex AI service-account JSON.
    // Operator pre-creates the SA out-of-band in a GCP project with Vertex
    // AI enabled in europe-west4 (roles/aiplatform.user) and seeds the JSON
    // into this secret via `aws secretsmanager put-secret-value` before
    // `cdk deploy`. dossier-loader Lambda fetches at cold start.
    this.gcpVertexSaSecret = mkSecret(
      'GcpVertexSa',
      'kos/gcp-vertex-sa',
      'GCP service-account JSON for Vertex AI Gemini 2.5 Pro europe-west4 (Phase 6 INF-10 dossier-loader).',
    );

    // Phase 4 Plan 04-01 (CAP-02): iOS Shortcut HMAC shared secret. The
    // ios-webhook Lambda fetches this on cold start and rejects any value
    // that is empty or the literal 'PLACEHOLDER' (T-04-IOS-03 fail-closed).
    // Operator seeds the real value via:
    //   aws secretsmanager put-secret-value \
    //     --secret-id kos/ios-shortcut-webhook-secret \
    //     --secret-string "$(openssl rand -hex 32)"
    this.iosShortcutWebhookSecret = mkSecret(
      'IosShortcutWebhookSecret',
      'kos/ios-shortcut-webhook-secret',
      'Shared HMAC-SHA256 secret for the iOS Action Button webhook (CAP-02 / D-01).',
    );

    // Phase 5 Plan 05-01 (CAP-04): chrome-webhook auth pair. The Bearer is
    // the cheap gate; the HMAC binds timestamp + body so a leaked Bearer
    // can't be replayed with mutated content (T-05-01-01).
    this.chromeExtensionBearerSecret = mkSecret(
      'ChromeExtensionBearer',
      'kos/chrome-extension-bearer',
      'Static Bearer token shared with the Kevin OS Chrome extension Options page (CAP-04).',
    );
    this.chromeExtensionHmacSecret = mkSecret(
      'ChromeExtensionHmacSecret',
      'kos/chrome-extension-hmac-secret',
      'Shared HMAC-SHA256 secret used by chrome-webhook + extension to sign every POST body (CAP-04).',
    );

    // --- Phase 4 Plan 04-03 (CAP-07): EmailEngine secrets -------------------
    // Five placeholders seeded by the operator post-deploy (see runbook).
    // RemovalPolicy.RETAIN keeps them across `cdk destroy` so re-deploys do
    // not require re-procuring the EmailEngine license or rotating Gmail app
    // passwords on every infra refresh.
    this.emailEngineLicenseSecret = mkSecret(
      'EmailEngineLicenseKey',
      'kos/emailengine-license-key',
      'EmailEngine Postal Systems license key (~$99/yr; see runbook for procurement).',
    );
    this.emailEngineImapElzarkaSecret = mkSecret(
      'EmailEngineImapKevinElzarka',
      'kos/emailengine-imap-kevin-elzarka',
      'IMAP credentials for kevin.elzarka@gmail.com — JSON {"email","app_password"}.',
    );
    this.emailEngineImapTaleforgeSecret = mkSecret(
      'EmailEngineImapKevinTaleforge',
      'kos/emailengine-imap-kevin-taleforge',
      'IMAP credentials for kevin@tale-forge.app — JSON {"email","app_password"}.',
    );
    this.emailEngineWebhookSecret = mkSecret(
      'EmailEngineWebhookSecret',
      'kos/emailengine-webhook-secret',
      'X-EE-Secret header value EmailEngine sends to emailengine-webhook Lambda (CAP-07).',
    );
    this.emailEngineApiKeySecret = mkSecret(
      'EmailEngineApiKey',
      'kos/emailengine-api-key',
      'EmailEngine REST API admin key (consumed by emailengine-admin Lambda).',
    );

    // --- ECS Fargate cluster (INF-06) ---------------------------------------
    // Phase 1: cluster shell only. Services (EmailEngine/Baileys/Postiz) attach
    // onto `this.ecsCluster` in Phases 4, 5, and 8. Platform version 1.4.0 and
    // ARM64 CPU architecture are declared at service-attach time, not here.
    this.ecsCluster = new KosCluster(this, 'EcsCluster', { vpc: props.vpc }).cluster;

    // --- Bastion (opt-in via CDK context) -----------------------------------
    // Usage: `cdk deploy KosData --context bastion=true` provisions the
    // short-lived bastion for Task 3's schema push. A follow-up deploy without
    // the flag tears it down (T-01-BASTION-01 mitigation).
    const bastionFlag = this.node.tryGetContext('bastion');
    if (bastionFlag === 'true' || bastionFlag === true) {
      new KosBastion(this, 'Bastion', {
        vpc: props.vpc,
        rdsSecurityGroup: this.rdsSecurityGroup,
      });
    }
  }
}
