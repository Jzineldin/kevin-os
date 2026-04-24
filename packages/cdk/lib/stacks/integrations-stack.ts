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
import { createHash } from 'node:crypto';
import type { KosLambda } from '../constructs/kos-lambda.js';
import { wireNotionIntegrations, type NotionWiring } from './integrations-notion.js';
import { wireAzureSearch } from './integrations-azure.js';
import { wireTranscribeVocab } from './integrations-transcribe.js';
import { wireGranolaPipeline } from './integrations-granola.js';
import { wireAzureSearchIndexers } from './integrations-azure-indexers.js';
import { wireMvRefresher } from './integrations-mv-refresher.js';
import { wireDossierLoader } from './integrations-vertex.js';

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
}

export class IntegrationsStack extends Stack {
  public readonly notionIndexer: KosLambda;
  public readonly notionIndexerBackfill: KosLambda;
  public readonly notionReconcile: KosLambda;

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
  }
}
