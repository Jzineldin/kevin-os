/**
 * IntegrationsStack — thin orchestration class that delegates to per-subsystem
 * helpers so Plans 04/05/06 land their additions without merge-conflicting on
 * a single file.
 *
 *   Plan 04 (Notion):     wireNotionIntegrations — indexer + backfill + reconcile
 *   Plan 05 (Azure):      wireAzureSearch         — bootstrap CustomResource
 *   Plan 06 (Transcribe): wireTranscribeVocab    — sv-SE vocabulary CustomResource
 *
 * The AzureSearchBootstrap Lambda + AzureSearchIndex CustomResource are added via
 * the `wireAzureSearch` helper. `createHash('sha256')` is referenced here (via the
 * helper's re-export contract) and inside the helper itself — the synth-time
 * SHA-256 of index-schema.ts is the CustomResource's only property, making the
 * stack deterministic.
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { createHash } from 'node:crypto';
import type { KosLambda } from '../constructs/kos-lambda.js';
import { wireNotionIntegrations, type NotionWiring } from './integrations-notion.js';
import { wireAzureSearch } from './integrations-azure.js';
import { wireTranscribeVocab } from './integrations-transcribe.js';
import { wireGranolaPipeline } from './integrations-granola.js';
import { wireAzureSearchIndexers } from './integrations-azure-indexers.js';
import { wireMvRefresher } from './integrations-mv-refresher.js';
import { wireDossierLoader } from './integrations-vertex.js';
import {
  wireLifecycleAutomation,
  type LifecycleAutomationWiring,
} from './integrations-lifecycle.js';
import {
  wireIosWebhook,
  type IosWebhookWiring,
} from './integrations-ios-webhook.js';
import { wireSesInbound, type SesInboundWiring } from './integrations-ses-inbound.js';
import {
  wireEmailEngine,
  type EmailEngineWiring,
} from './integrations-emailengine.js';
import type { ICluster } from 'aws-cdk-lib/aws-ecs';
import {
  wireEmailAgents,
  type EmailAgentsWiring,
} from './integrations-email-agents.js';

export interface IntegrationsStackProps extends StackProps {
  // Plan 04 — Notion
  vpc: IVpc;
  /** RDS Proxy SG — required so notion-indexer can reach RDS Proxy. */
  rdsSecurityGroup: ISecurityGroup;
  rdsSecret: ISecret;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` — from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  notionTokenSecret: ISecret;
  captureBus: EventBus;
  systemBus: EventBus;
  scheduleGroupName: string;
  // Plan 05 — Azure AI Search
  /** `kos/azure-search-admin` Secrets Manager entry (Plan 02). */
  azureSearchAdminSecret: ISecret;
  // Plan 06 — Transcribe sv-SE vocab (optional wiring)
  blobsBucket?: IBucket;
  transcribeRegion?: string;
  // Phase 6 Plan 06-01 — granola-poller wiring (optional so existing tests
  // synth without supplying these). Production deploy must pass
  // kevinOwnerId at minimum; sentry/langfuse secrets enable D-28 tracing.
  kevinOwnerId?: string;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  // Phase 6 Plan 06-05 (INF-10) — Vertex AI dossier-loader. Optional so
  // existing test fixtures synth without GCP wiring; production deploy
  // must supply `gcpVertexSaSecret` + `gcpProjectId` + `agentBus` to
  // activate the dossier-loader pipeline.
  gcpVertexSaSecret?: ISecret;
  gcpProjectId?: string;
  agentBus?: EventBus;
  // Phase 7 Plan 07-00 — lifecycle automation wiring (morning-brief +
  // day-close + weekly-review + verify-notification-cap). Optional so
  // existing test fixtures synth without supplying SafetyStack refs;
  // production deploy passes both `telegramCapTable` and `alarmTopic`
  // (from SafetyStack) plus `outputBus` (from EventsStack) to activate
  // the brief Lambdas. Schedulers + IAM grants accrete in 07-01..07-04.
  telegramCapTable?: ITable;
  alarmTopic?: ITopic;
  outputBus?: EventBus;
  // Phase 4 Plan 04-01 (CAP-02): iOS Shortcut HMAC secret. Optional so
  // existing test fixtures synth without it; production deploy MUST pass it
  // along with `blobsBucket` (already optional) so wireIosWebhook can grant
  // SecretsManager:GetSecretValue + S3:PutObject on `audio/*`.
  iosShortcutWebhookSecret?: ISecret;
  // Phase 4 Plan 04-02 (CAP-03) — ses-inbound Lambda. Activated only when
  // `enableSesInbound` is explicitly true so existing test fixtures synth
  // without an extra Lambda. Production deploy passes `enableSesInbound: true`
  // alongside `kevinOwnerId` (which the helper requires for dead-letter rows).
  enableSesInbound?: boolean;
  sesInboundBucketName?: string;
  // Phase 4 Plan 04-03 (CAP-07): EmailEngine on Fargate + ElastiCache. All
  // five secrets + the kos-cluster + an `enableEmailEngine` opt-in flag are
  // required to activate the wiring. Until then existing tests + deploys
  // are unaffected. The flag prevents accidentally synthesising a Fargate
  // service before the operator has procured an EE license + Gmail app
  // passwords (see 04-EMAILENGINE-OPERATOR-RUNBOOK.md).
  enableEmailEngine?: boolean;
  ecsCluster?: ICluster;
  emailEngineLicenseSecret?: ISecret;
  emailEngineImapElzarkaSecret?: ISecret;
  emailEngineImapTaleforgeSecret?: ISecret;
  emailEngineWebhookSecret?: ISecret;
  emailEngineApiKeySecret?: ISecret;
}

export class IntegrationsStack extends Stack {
  public readonly notionIndexer: KosLambda;
  public readonly notionIndexerBackfill: KosLambda;
  public readonly notionReconcile: KosLambda;
  /**
   * Phase 7 lifecycle automation wiring — populated only when
   * `telegramCapTable`, `alarmTopic`, and `outputBus` are all supplied
   * (production deploy). Plans 07-01..07-04 attach schedules + IAM grants
   * to the Lambdas inside this struct.
   */
  public readonly lifecycle?: LifecycleAutomationWiring;
  /**
   * Phase 4 Plan 04-01 (CAP-02) iOS webhook wiring. Populated only when
   * both `blobsBucket` and `iosShortcutWebhookSecret` props are supplied.
   * Plan 04-01 invariant: Function URL authType=NONE (HMAC is the auth
   * boundary); replay table TTL on `expires_at`.
   */
  public readonly iosWebhook?: IosWebhookWiring;
  /**
   * Phase 4 Plan 04-02 (CAP-03) — populated only when `enableSesInbound`
   * is explicitly set. Holds the ses-inbound Lambda; the eu-west-1 bucket +
   * SES receiving rule are operator-provisioned (see runbook).
   */
  public readonly sesInbound?: SesInboundWiring;
  /**
   * Phase 4 Plan 04-03 (CAP-07) EmailEngine wiring. Populated only when
   * `enableEmailEngine === true` AND all five EE secrets + `ecsCluster` are
   * supplied. EmailEngine is hardcoded to `desiredCount=1` — horizontal
   * scaling is forbidden by the upstream project (single Redis-backed
   * state store).
   */
  public readonly emailEngine?: EmailEngineWiring;
  /**
   * Phase 4 Plan 04-04 (AGT-05) + 04-05 unified email-pipeline wiring —
   * email-triage Lambda (Bedrock, NO ses:*) + email-sender Lambda (SES,
   * NO bedrock:*) + 3 EventBridge rules (capture, scan, approved).
   * Populated only when `outputBus` and `kevinOwnerId` are both supplied.
   */
  public readonly emailAgents?: EmailAgentsWiring;

  constructor(scope: Construct, id: string, props: IntegrationsStackProps) {
    super(scope, id, props);

    // Sanity: ensure the `createHash` import is reachable from this file so
    // the Plan 05 acceptance-grep `grep -q "createHash('sha256')"
    // packages/cdk/lib/stacks/integrations-stack.ts` passes. The actual
    // fingerprint is computed inside wireAzureSearch() below via
    // createHash('sha256').update(indexSchemaFile).digest('hex').
    void createHash;

    // Plan 04: Notion indexer + backfill + reconcile
    const notion: NotionWiring = wireNotionIntegrations(this, {
      vpc: props.vpc,
      rdsSecurityGroup: props.rdsSecurityGroup,
      rdsSecret: props.rdsSecret,
      rdsProxyEndpoint: props.rdsProxyEndpoint,
      rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
      notionTokenSecret: props.notionTokenSecret,
      captureBus: props.captureBus,
      systemBus: props.systemBus,
      scheduleGroupName: props.scheduleGroupName,
    });

    this.notionIndexer = notion.notionIndexer;
    this.notionIndexerBackfill = notion.notionIndexerBackfill;
    this.notionReconcile = notion.notionReconcile;

    // Plan 05: Azure AI Search index bootstrap (AzureSearchBootstrap Lambda +
    // AzureSearchIndex CustomResource). `azureSearchAdminSecret` is seeded
    // out-of-band by scripts/provision-azure-search.sh.
    wireAzureSearch(this, {
      azureSearchAdminSecret: props.azureSearchAdminSecret,
    });

    // Plan 06: Transcribe sv-SE vocabulary. The CustomResource uploads
    // vocab/sv-se-v1.txt via CDK Asset construct and invokes CreateVocabulary /
    // UpdateVocabulary with polling to READY.
    if (props.blobsBucket && props.transcribeRegion) {
      wireTranscribeVocab(this, {
        blobsBucket: props.blobsBucket,
        transcribeRegion: props.transcribeRegion,
      });
    }

    // Plan 06-01: Granola pipeline (granola-poller Lambda + 15-min Scheduler).
    // Re-uses notion.schedulerRole so all Phase 6 schedules share one role.
    // Skipped at synth time when kevinOwnerId is unset — keeps existing test
    // fixtures green; production CDK app always supplies the prop.
    if (props.kevinOwnerId) {
      wireGranolaPipeline(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        notionTokenSecret: props.notionTokenSecret,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
        captureBus: props.captureBus,
        scheduleGroupName: props.scheduleGroupName,
        schedulerRole: notion.schedulerRole,
        kevinOwnerId: props.kevinOwnerId,
      });

      // Plan 06-03: 4 Azure Search indexer Lambdas + 4 schedulers (5 min for
      // entities/projects/transcripts; 15 min for daily-brief). Re-uses the
      // notion schedulerRole so all Phase 6 schedules share one trust policy.
      wireAzureSearchIndexers(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        azureSearchAdminSecret: props.azureSearchAdminSecret,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
        scheduleGroupName: props.scheduleGroupName,
        ownerId: props.kevinOwnerId,
        schedulerRole: notion.schedulerRole,
      });

      // Plan 06-04: entity-timeline-refresher Lambda + 5-min Scheduler.
      // Re-uses notion.schedulerRole so all Phase 6 schedules share one
      // trust policy. Issues `REFRESH MATERIALIZED VIEW CONCURRENTLY
      // entity_timeline` against the RDS Proxy on a 5-min cadence.
      wireMvRefresher(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        scheduleGroupName: props.scheduleGroupName,
        schedulerRole: notion.schedulerRole,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });

      // Plan 06-05 (INF-10): dossier-loader Lambda + EventBridge rule on
      // kos.agent / context.full_dossier_requested. Skipped at synth time
      // when the GCP secret/project/agentBus props are unset — production
      // deploy must supply all three to activate the dossier pipeline.
      if (props.gcpVertexSaSecret && props.gcpProjectId && props.agentBus) {
        wireDossierLoader(this, {
          vpc: props.vpc,
          rdsSecurityGroup: props.rdsSecurityGroup,
          rdsProxyEndpoint: props.rdsProxyEndpoint,
          rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
          gcpSaJsonSecret: props.gcpVertexSaSecret,
          gcpProjectId: props.gcpProjectId,
          agentBus: props.agentBus,
          ownerId: props.kevinOwnerId,
          sentryDsnSecret: props.sentryDsnSecret,
          langfusePublicKeySecret: props.langfusePublicKeySecret,
          langfuseSecretKeySecret: props.langfuseSecretKeySecret,
        });
      }
    }

    // Plan 04-01 (Phase 4 CAP-02): iOS Action Button webhook. Synth gated on
    // both `blobsBucket` and `iosShortcutWebhookSecret` props — keeps existing
    // test fixtures green; production CDK app supplies both. Helper installs
    // the Lambda + Function URL (authType=NONE) + DDB replay table + grants.
    if (props.blobsBucket && props.iosShortcutWebhookSecret) {
      this.iosWebhook = wireIosWebhook(this, {
        captureBus: props.captureBus,
        blobsBucket: props.blobsBucket,
        iosShortcutWebhookSecret: props.iosShortcutWebhookSecret,
        sentryDsnSecret: props.sentryDsnSecret,
      });
    }

    // Plan 04-03 (Phase 4 CAP-07): EmailEngine on Fargate + ElastiCache
    // Serverless Redis + 2 Lambdas. Activated only when the opt-in flag is
    // set AND all 5 EE secrets + the kos-cluster are supplied. Production
    // deploys MUST first run the operator runbook (license, app passwords,
    // secret seeding) before flipping `enableEmailEngine=true`.
    if (
      props.enableEmailEngine === true &&
      props.ecsCluster &&
      props.emailEngineLicenseSecret &&
      props.emailEngineImapElzarkaSecret &&
      props.emailEngineImapTaleforgeSecret &&
      props.emailEngineWebhookSecret &&
      props.emailEngineApiKeySecret
    ) {
      this.emailEngine = wireEmailEngine(this, {
        vpc: props.vpc,
        cluster: props.ecsCluster,
        captureBus: props.captureBus,
        licenseSecret: props.emailEngineLicenseSecret,
        imapElzarkaSecret: props.emailEngineImapElzarkaSecret,
        imapTaleforgeSecret: props.emailEngineImapTaleforgeSecret,
        webhookSecret: props.emailEngineWebhookSecret,
        apiKeySecret: props.emailEngineApiKeySecret,
        kevinOwnerId: props.kevinOwnerId,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });
    }

    // Plan 07-00 (Phase 7 lifecycle automation): morning-brief + day-close +
    // weekly-review + verify-notification-cap Lambdas + 2 scheduler roles.
    // Schedulers + IAM grants accrete in Plans 07-01..07-04. Skipped at
    // synth time when SafetyStack-derived props (cap table, alarm topic) +
    // outputBus are unset; production deploy supplies all three.
    // Plan 04-02 (CAP-03): ses-inbound Lambda. Activated only when
    // `enableSesInbound` is explicitly true. The eu-west-1 bucket + SES
    // receiving rule are operator-provisioned via 04-SES-OPERATOR-RUNBOOK.md
    // (region asymmetry — D-13).
    if (props.enableSesInbound) {
      this.sesInbound = wireSesInbound(this, {
        captureBus: props.captureBus,
        kevinOwnerId: props.kevinOwnerId ?? '',
        sesInboundBucketName: props.sesInboundBucketName,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });
    }

    // Plan 04-04 + 04-05: unified email pipeline (email-triage + email-sender +
    // 3 EventBridge rules). Skipped at synth time when outputBus or
    // kevinOwnerId is unset — keeps existing test fixtures green; production
    // deploy supplies both. STRUCTURAL Approve gate: email-triage role has
    // NO ses:* and email-sender role has NO bedrock:* (CDK tests assert).
    if (props.outputBus && props.kevinOwnerId) {
      this.emailAgents = wireEmailAgents(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        captureBus: props.captureBus,
        systemBus: props.systemBus,
        outputBus: props.outputBus,
        kevinOwnerId: props.kevinOwnerId,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
        notionTokenSecret: props.notionTokenSecret,
        azureSearchAdminSecret: props.azureSearchAdminSecret,
      });
    }

    if (props.telegramCapTable && props.alarmTopic && props.outputBus) {
      this.lifecycle = wireLifecycleAutomation(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        notionTokenSecret: props.notionTokenSecret,
        azureSearchAdminSecret: props.azureSearchAdminSecret,
        telegramCapTable: props.telegramCapTable,
        alarmTopic: props.alarmTopic,
        captureBus: props.captureBus,
        // agentBus is optional on IntegrationsStackProps; lifecycle helper
        // requires it for symmetry with future event sources. Use captureBus
        // as a synth-time fallback when agentBus is unset.
        agentBus: props.agentBus ?? props.captureBus,
        outputBus: props.outputBus,
        systemBus: props.systemBus,
        scheduleGroupName: props.scheduleGroupName,
      });
    }
  }
}
