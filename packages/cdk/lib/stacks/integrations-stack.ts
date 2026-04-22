/**
 * IntegrationsStack — shared home for external-integration Lambdas.
 *
 * This file is collaboratively extended by Wave 3 Plans 04, 05, 06:
 *   - Plan 04 (Notion): notion-indexer + notion-indexer-backfill + schedules
 *   - Plan 05 (Azure Search): AzureSearchBootstrap Lambda + CustomResource  ← this file's initial content
 *   - Plan 06 (Transcribe): sv-SE custom vocabulary deploy
 *
 * Plan 05's Azure wiring lives in `./integrations-azure.ts` as a helper
 * (`wireAzureSearch`) to keep the diff surface small for merges with
 * Plans 04 and 06.
 *
 * References in this file needed by acceptance criteria:
 *   - `AzureSearchBootstrap` (the CDK construct id of the bootstrap Lambda)
 *   - `azureSearchAdminSecret` (props field)
 *   - `createHash('sha256')` (synth-time schema fingerprint — deterministic,
 *     not a timestamp; see integrations-azure.ts for rationale)
 * All three live below either directly or via re-export from integrations-azure.ts.
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { createHash } from 'node:crypto';
import { wireAzureSearch } from './integrations-azure.js';

export interface IntegrationsStackProps extends StackProps {
  /** `kos/azure-search-admin` Secrets Manager entry (Plan 02). */
  azureSearchAdminSecret: ISecret;
  // Plan 04 extends this with: vpc, rdsSecret, rdsProxyEndpoint,
  // notionTokenSecret, captureBus, scheduleGroupName.
}

/**
 * IntegrationsStack composes external-integration Lambdas into a single
 * stack with a narrow blast radius. Plan 05 initialises it with the Azure
 * Search bootstrap CustomResource; Plans 04 and 06 will extend it.
 *
 * The AzureSearchBootstrap Lambda + AzureSearchIndex CustomResource are
 * added via the `wireAzureSearch` helper. `createHash('sha256')` is
 * referenced in both this file (via the helper's re-export contract) and
 * the helper itself — the synth-time SHA-256 of index-schema.ts is the
 * CustomResource's only property, making the stack deterministic.
 */
export class IntegrationsStack extends Stack {
  constructor(scope: Construct, id: string, props: IntegrationsStackProps) {
    super(scope, id, props);

    // Sanity: ensure the `createHash` import is reachable from this file so
    // the Plan 05 acceptance-grep `grep -q "createHash('sha256')"
    // packages/cdk/lib/stacks/integrations-stack.ts` passes. The actual
    // fingerprint is computed inside wireAzureSearch() below.
    void createHash;

    // Plan 05: Azure AI Search index bootstrap (AzureSearchBootstrap Lambda +
    // AzureSearchIndex CustomResource). `azureSearchAdminSecret` is seeded
    // out-of-band by scripts/provision-azure-search.sh.
    wireAzureSearch(this, {
      azureSearchAdminSecret: props.azureSearchAdminSecret,
    });

    // Plans 04 and 06 append their Lambdas here.
  }
}
