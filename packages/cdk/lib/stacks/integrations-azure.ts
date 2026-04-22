/**
 * Azure AI Search CDK wiring — Plan 01-05.
 *
 * Factored into a helper so Plans 04 (Notion) and 06 (Transcribe vocab) can
 * extend the same `IntegrationsStack` without colliding on git merges. Plan 04
 * is the canonical author of `IntegrationsStack` itself; this file only adds
 * the Azure bootstrap Lambda + CustomResource.
 *
 * Call from inside the IntegrationsStack constructor:
 *
 *     wireAzureSearch(this, {
 *       azureSearchAdminSecret: props.azureSearchAdminSecret,
 *     });
 *
 * Deterministic fingerprinting: the CustomResource's `schemaFingerprint`
 * property is a SHA-256 of the index-schema.ts file content computed AT SYNTH
 * TIME. Two consecutive `cdk synth` runs with no file change produce a
 * byte-identical template (CustomResource only re-invokes when the schema
 * file actually changes). Do NOT use `Date.now()` — that would force an
 * Azure PUT on every deploy and defeat idempotency.
 */
import { CustomResource, Duration } from 'aws-cdk-lib';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WireAzureSearchProps {
  /**
   * The `kos/azure-search-admin` Secrets Manager entry created in Plan 02.
   * Seeded out-of-band by `scripts/provision-azure-search.sh` before deploy.
   */
  azureSearchAdminSecret: ISecret;
}

export interface WireAzureSearchResult {
  bootstrapFunction: KosLambda;
  customResource: CustomResource;
  schemaFingerprint: string;
}

/**
 * Adds the Azure Search bootstrap Lambda + CustomResource to `scope`.
 * Intended to be called from `IntegrationsStack`'s constructor.
 */
export function wireAzureSearch(
  scope: Construct,
  props: WireAzureSearchProps,
): WireAzureSearchResult {
  // Path resolution: packages/cdk/lib/stacks → services/azure-search-bootstrap
  // Five ../ segments to reach repo root, then into the service package.
  const serviceRoot = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'services',
    'azure-search-bootstrap',
  );
  const entryPath = path.join(serviceRoot, 'src', 'handler.ts');
  const indexSchemaPath = path.join(serviceRoot, 'src', 'index-schema.ts');

  // Synth-time fingerprint of the schema file. The CustomResource only
  // receives a change event when this hex digest changes — i.e. when the
  // index definition itself has been modified. Deterministic across
  // developer workstations and CI.
  const schemaFingerprint = createHash('sha256')
    .update(fs.readFileSync(indexSchemaPath))
    .digest('hex');

  const bootstrapFunction = new KosLambda(scope, 'AzureSearchBootstrap', {
    entry: entryPath,
    timeout: Duration.minutes(5),
    memory: 512,
    environment: {
      AZURE_SEARCH_SECRET_ARN: props.azureSearchAdminSecret.secretArn,
    },
  });
  props.azureSearchAdminSecret.grantRead(bootstrapFunction);

  const provider = new Provider(scope, 'AzureBootstrapProvider', {
    onEventHandler: bootstrapFunction,
  });

  const customResource = new CustomResource(scope, 'AzureSearchIndex', {
    serviceToken: provider.serviceToken,
    properties: { schemaFingerprint },
  });

  return { bootstrapFunction, customResource, schemaFingerprint };
}
