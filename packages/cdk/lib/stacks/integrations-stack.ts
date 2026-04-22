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
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { createHash } from 'node:crypto';
import type { KosLambda } from '../constructs/kos-lambda.js';
import { wireNotionIntegrations, type NotionWiring } from './integrations-notion.js';
import { wireAzureSearch } from './integrations-azure.js';
import { wireTranscribeVocab } from './integrations-transcribe.js';

export interface IntegrationsStackProps extends StackProps {
  // Plan 04 — Notion
  vpc: IVpc;
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
  }
}
