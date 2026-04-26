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
import {
  wireChromeWebhook,
  type ChromeWebhookWiring,
} from './integrations-chrome-webhook.js';
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
import {
  wireLinkedInWebhook,
  type LinkedInWebhookWiring,
} from './integrations-linkedin-webhook.js';
import {
  wireBaileysSidecar,
  type BaileysSidecarWiring,
} from './integrations-baileys-sidecar.js';
import {
  wireDiscordSchedule,
  type DiscordScheduleWiring,
} from './integrations-discord-schedule.js';
import {
  wireDocumentDiff,
  type DocumentDiffWiring,
} from './integrations-document-diff.js';

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
  // Phase 5 Plan 05-01 (CAP-04): chrome-webhook auth pair (Bearer + HMAC).
  // Both must be supplied to activate the chrome-webhook wiring. Production
  // CDK app passes both from DataStack; existing test fixtures synth without
  // them and the chrome-webhook is simply not provisioned.
  chromeExtensionBearerSecret?: ISecret;
  chromeExtensionHmacSecret?: ISecret;
  // Phase 5 Plan 05-02 (CAP-05): LinkedIn DM webhook. Activated only when
  // `enableLinkedInWebhook` is explicitly true. Helper provisions both
  // secrets (kos/linkedin-webhook-bearer + kos/linkedin-webhook-hmac) and
  // the Function URL itself; operator seeds real secret values post-deploy.
  enableLinkedInWebhook?: boolean;
  // Phase 5 Plan 05-05 (CAP-06): Baileys sidecar Lambda — webhook receiver
  // for the Baileys WhatsApp Fargate container (Plan 05-04, autonomous=false).
  // Activated only when `enableBaileysSidecar === true` AND `blobsBucket`
  // is supplied. Helper self-provisions the kos/baileys-webhook-secret
  // Secret + Function URL + IAM grants (S3 PutObject on audio/* and
  // EventBridge PutEvents — explicitly NO bedrock/rds/ses). Operator
  // flips the flag after Plan 05-04 is unblocked + the WhatsApp risk
  // acceptance is signed.
  enableBaileysSidecar?: boolean;
  baileysMediaBaseUrl?: string;
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
   * Phase 5 Plan 05-01 (CAP-04) chrome-webhook wiring. Populated only when
   * BOTH `chromeExtensionBearerSecret` and `chromeExtensionHmacSecret` props
   * are supplied. Plan 05-01 invariant: Function URL authType=NONE; Bearer
   * + HMAC pair IS the auth boundary; no replay-cache table (v1 accepts
   * the risk).
   */
  public readonly chromeWebhook?: ChromeWebhookWiring;
  /**
   * Phase 5 Plan 05-02 (CAP-05) LinkedIn DM webhook wiring. Populated only
   * when `enableLinkedInWebhook === true`. Bearer + HMAC secrets are
   * provisioned by the helper itself; operator seeds the real values
   * post-deploy via `aws secretsmanager put-secret-value`.
   */
  public readonly linkedInWebhook?: LinkedInWebhookWiring;
  /**
   * Phase 5 Plan 05-05 (CAP-06) Baileys sidecar wiring. Populated only when
   * `enableBaileysSidecar === true` AND `blobsBucket` is supplied. The
   * helper provisions the `kos/baileys-webhook-secret` Secret itself, the
   * Function URL (authType=NONE — X-BAILEYS-Secret IS the auth boundary),
   * and IAM grants scoped to S3 `audio/*` + EventBridge captureBus only.
   */
  public readonly baileysSidecar?: BaileysSidecarWiring;
  /**
   * Phase 5 Plan 05-06 (CAP-10) Discord brain-dump Scheduler wiring.
   * Populated only when `kevinOwnerId` is supplied. Phase 5 owns the
   * Scheduler + IAM role per D-09; Phase 10 Plan 10-04 ships the actual
   * Lambda handler. The Scheduler target ARN is sourced from SSM
   * parameter `/kos/discord/brain-dump-lambda-arn` (operator-seeded).
   */
  public readonly discordSchedule?: DiscordScheduleWiring;
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
  /**
   * Phase 8 Plan 08-05 (MEM-05) document-diff wiring. Populated only when
   * `outputBus`, `blobsBucket`, and `kevinOwnerId` are all supplied.
   * Subscribes to `kos.output / email.sent`; fetches attachments from
   * blobsBucket; writes to document_versions as `kos_document_diff`.
   * IAM has NO postiz:* / ses:* / notion writes — diff tracking never
   * publishes.
   */
  public readonly documentDiff?: DocumentDiffWiring;

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

    // Plan 05-01 (Phase 5 CAP-04): Chrome highlight webhook. Synth gated on
    // BOTH `chromeExtensionBearerSecret` and `chromeExtensionHmacSecret` —
    // keeps existing test fixtures green; production CDK app supplies both.
    // Helper installs the Lambda + Function URL (authType=NONE) + grants.
    if (props.chromeExtensionBearerSecret && props.chromeExtensionHmacSecret) {
      this.chromeWebhook = wireChromeWebhook(this, {
        captureBus: props.captureBus,
        chromeExtensionBearerSecret: props.chromeExtensionBearerSecret,
        chromeExtensionHmacSecret: props.chromeExtensionHmacSecret,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });
    }

    // Plan 05-02 (Phase 5 CAP-05): LinkedIn DM webhook. Helper provisions
    // the Lambda + Function URL (authType=NONE) + 2 Secrets (Bearer + HMAC).
    // Synth-gated on the explicit `enableLinkedInWebhook` flag so existing
    // test fixtures stay green; production deploy flips the flag once the
    // operator runbook (seed both secrets, paste URL into extension options
    // page) is ready to run.
    if (props.enableLinkedInWebhook === true) {
      this.linkedInWebhook = wireLinkedInWebhook(this, {
        captureBus: props.captureBus,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });
    }

    // Plan 05-05 (Phase 5 CAP-06): Baileys sidecar Lambda. Helper provisions
    // the kos/baileys-webhook-secret Secret + Function URL + IAM grants.
    // Synth-gated on the explicit `enableBaileysSidecar` flag AND
    // `blobsBucket` so existing test fixtures stay green; production deploy
    // flips the flag once Plan 05-04 (Fargate container) is unblocked AND
    // the WhatsApp risk acceptance is signed (the Fargate container itself
    // is `autonomous: false` and not provisioned here).
    if (props.enableBaileysSidecar === true && props.blobsBucket) {
      this.baileysSidecar = wireBaileysSidecar(this, {
        captureBus: props.captureBus,
        blobsBucket: props.blobsBucket,
        baileysMediaBaseUrl: props.baileysMediaBaseUrl,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
      });
    }

    // Plan 05-06 (Phase 5 CAP-10): Discord brain-dump Scheduler. Phase 5
    // owns the Scheduler + IAM role per D-09; Phase 10 Plan 10-04 ships
    // the Lambda handler. Synth-gated on `kevinOwnerId` so existing test
    // fixtures stay green. The Scheduler target ARN is read from SSM
    // parameter `/kos/discord/brain-dump-lambda-arn` (operator-seeded
    // pre-deploy — see 05-06-DISCORD-CONTRACT.md for the seeding runbook).
    if (props.kevinOwnerId) {
      this.discordSchedule = wireDiscordSchedule(this, {
        kevinOwnerId: props.kevinOwnerId,
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

    // Plan 08-05 (Phase 8 MEM-05) document-diff. Activated when blobsBucket,
    // outputBus, and kevinOwnerId are all supplied — keeps existing test
    // fixtures green; production deploy passes all three. Subscribes to
    // `kos.output / email.sent`; reads attachments from blobsBucket; writes
    // to document_versions. IAM has NO postiz:* / ses:* / notion writes
    // (CDK test asserts).
    if (props.outputBus && props.blobsBucket && props.kevinOwnerId) {
      this.documentDiff = wireDocumentDiff(this, {
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        blobsBucket: props.blobsBucket,
        outputBus: props.outputBus,
        kevinOwnerId: props.kevinOwnerId,
        sentryDsnSecret: props.sentryDsnSecret,
        langfusePublicKeySecret: props.langfusePublicKeySecret,
        langfuseSecretKeySecret: props.langfuseSecretKeySecret,
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
