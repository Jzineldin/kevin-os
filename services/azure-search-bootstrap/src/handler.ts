/**
 * CloudFormation CustomResource handler — creates the Azure AI Search
 * `kos-memory-v1` index with binary quantization at CREATION time.
 *
 * Lifecycle:
 *   Create: fetch admin creds → optional pre-PUT divergence check → PUT
 *           index definition → post-PUT GET verifies compressions[0].kind
 *   Update: same as Create (PUT is idempotent for non-breaking changes; the
 *           pre-PUT check rejects breaking changes with a clear rename-to-vN+1
 *           error before Azure returns a cryptic 400).
 *   Delete: NO-OP — archive-not-delete (CONTEXT D-03 extended to Azure).
 *           Destroying a quantized index forces a full reindex, which must
 *           be an explicit operator action, not a stack tear-down side effect.
 *
 * Invoked via `aws-cdk-lib/custom-resources` Provider, which handles the
 * CloudFormation response protocol for us (we return a plain object with
 * PhysicalResourceId / Data and the Provider writes the signed response).
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import {
  KOS_MEMORY_INDEX_DEFINITION,
  KOS_MEMORY_INDEX_NAME,
} from './index-schema.js';

// Azure AI Search REST: api-version=2025-09-01 (stable GA, RESEARCH §1)
const API_VERSION = '2025-09-01';
const sm = new SecretsManagerClient({});

interface AzureCreds {
  endpoint: string;
  adminKey: string;
}

async function getAzureCreds(): Promise<AzureCreds> {
  const secretId = process.env.AZURE_SEARCH_SECRET_ARN;
  if (!secretId) {
    throw new Error('AZURE_SEARCH_SECRET_ARN env var is required');
  }
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!r.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString`);
  }
  const parsed = JSON.parse(r.SecretString) as Partial<AzureCreds>;
  if (!parsed.endpoint || !parsed.adminKey) {
    throw new Error(
      `Secret ${secretId} missing endpoint/adminKey — run scripts/provision-azure-search.sh first`,
    );
  }
  return { endpoint: parsed.endpoint, adminKey: parsed.adminKey };
}

export interface BootstrapResponse {
  PhysicalResourceId: string;
  Data?: { indexName: string; endpoint: string };
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
): Promise<BootstrapResponse> {
  if (event.RequestType === 'Delete') {
    // Archive-not-delete (CONTEXT D-03): index survives stack destruction.
    //
    // Echo back the incoming PhysicalResourceId so CloudFormation never sees
    // the ID change between CREATE and DELETE (which otherwise triggers
    // `cannot change the physical resource ID from X to Y during deletion`
    // and traps the stack in ROLLBACK_FAILED — see 2026-04-22 retro;
    // same pattern applied to Transcribe handler earlier).
    return {
      PhysicalResourceId:
        (event as { PhysicalResourceId?: string }).PhysicalResourceId ??
        KOS_MEMORY_INDEX_NAME,
    };
  }

  const { endpoint, adminKey } = await getAzureCreds();
  const url = `${endpoint}/indexes/${KOS_MEMORY_INDEX_NAME}?api-version=${API_VERSION}`;

  // Pre-PUT divergence check: if the index exists with a different field
  // set, throw an actionable rename-to-vN+1 error BEFORE Azure rejects with
  // a cryptic 400. Non-breaking PUTs (semantic config tweaks, etc.) fall
  // through to the PUT below.
  const existingRes = await fetch(url, { headers: { 'api-key': adminKey } });
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as {
      fields?: Array<{ name: string }>;
    };
    const existingFieldNames = (existing.fields ?? [])
      .map((f) => f.name)
      .sort();
    const desiredFieldNames = KOS_MEMORY_INDEX_DEFINITION.fields
      .map((f) => f.name)
      .slice()
      .sort();
    const mismatch =
      existingFieldNames.length !== desiredFieldNames.length ||
      existingFieldNames.some((n, i) => n !== desiredFieldNames[i]);
    if (mismatch) {
      throw new Error(
        `Azure Search index ${KOS_MEMORY_INDEX_NAME} exists with divergent fields ` +
          `[${existingFieldNames.join(',')}] vs desired [${desiredFieldNames.join(',')}]. ` +
          `Azure does not support breaking field changes via PUT. Rename the index ` +
          `(bump KOS_MEMORY_INDEX_NAME to 'kos-memory-v2') in index-schema.ts, redeploy, ` +
          `and backfill from source of truth in Phase 6.`,
      );
    }
  } else if (existingRes.status !== 404) {
    throw new Error(
      `Azure Search pre-check failed ${existingRes.status}: ${await existingRes.text()}`,
    );
  }

  // PUT (idempotent create-or-update for non-breaking changes).
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-key': adminKey,
    },
    body: JSON.stringify(KOS_MEMORY_INDEX_DEFINITION),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Azure Search index PUT failed ${res.status}: ${body}`);
  }

  // Post-create verification — assert binaryQuantization is live on the
  // service, not just present in our payload. This catches the case where
  // a future Azure API version silently drops the field.
  const verify = await fetch(url, { headers: { 'api-key': adminKey } });
  if (!verify.ok) {
    throw new Error(
      `Azure Search post-PUT GET failed ${verify.status}: ${await verify.text()}`,
    );
  }
  const idx = (await verify.json()) as {
    vectorSearch?: {
      compressions?: Array<{ kind?: string }>;
    };
  };
  const kind = idx.vectorSearch?.compressions?.[0]?.kind;
  if (kind !== 'binaryQuantization') {
    throw new Error(
      `Binary quantization missing on created index: got kind=${kind ?? 'undefined'}`,
    );
  }

  return {
    PhysicalResourceId: KOS_MEMORY_INDEX_NAME,
    Data: { indexName: KOS_MEMORY_INDEX_NAME, endpoint },
  };
}
