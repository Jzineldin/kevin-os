/**
 * Azure AI Search client factory.
 *
 * Resolves credentials from Secrets Manager at cold start, caches client
 * instance for the Lambda container lifetime.
 */
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface AzureSearchConfig {
  endpoint: string;
  indexName: string;
  apiKey: string;
}

// SearchClient<TModel extends object> in @azure/search-documents v12.2 — the
// generic must satisfy the object constraint. Use a default Record<string, unknown>
// so callers that don't supply T (i.e. test fixtures) still typecheck.
type AnyDoc = Record<string, unknown>;
let cached: Map<string, SearchClient<AnyDoc>> = new Map();

export async function getAzureSearchClient<T extends object = AnyDoc>(
  indexName: string,
): Promise<SearchClient<T>> {
  const cacheKey = `index:${indexName}`;
  const hit = cached.get(cacheKey);
  if (hit) return hit as unknown as SearchClient<T>;

  const config = await loadConfig();
  const client = new SearchClient<T>(
    config.endpoint,
    indexName,
    new AzureKeyCredential(config.apiKey),
    { apiVersion: '2025-09-01' as unknown as undefined },
  );
  cached.set(cacheKey, client as unknown as SearchClient<AnyDoc>);
  return client;
}

async function loadConfig(): Promise<{ endpoint: string; apiKey: string }> {
  // Two supported shapes (Phase 6 reality reconciliation):
  //   1. Unified `kos/azure-search-admin` JSON secret containing
  //      `{endpoint, adminKey}` — the format produced by
  //      `scripts/provision-azure-search.sh` and consumed by
  //      `services/azure-search-bootstrap`. Pass via
  //      AZURE_SEARCH_ADMIN_SECRET_ARN; AZURE_SEARCH_ENDPOINT_SECRET_ARN can
  //      be unset.
  //   2. Two-secret legacy: AZURE_SEARCH_ENDPOINT_SECRET_ARN holds plain
  //      endpoint string; AZURE_SEARCH_ADMIN_SECRET_ARN holds plain admin
  //      key. Backward-compatibility for any test fixture that bound them
  //      separately.
  const endpointArn = process.env.AZURE_SEARCH_ENDPOINT_SECRET_ARN;
  const adminArn = process.env.AZURE_SEARCH_ADMIN_SECRET_ARN;
  if (!adminArn) {
    throw new Error('AZURE_SEARCH_ADMIN_SECRET_ARN env var required');
  }
  const sm = new SecretsManagerClient({});

  const adminRes = await sm.send(new GetSecretValueCommand({ SecretId: adminArn }));
  const adminRaw = adminRes.SecretString ?? '';
  if (!adminRaw) throw new Error(`Azure Search admin secret ${adminArn} empty`);

  // Try shape #1 — unified JSON.
  let endpoint = '';
  let apiKey = '';
  try {
    const parsed = JSON.parse(adminRaw) as { endpoint?: string; adminKey?: string };
    if (parsed.endpoint && parsed.adminKey) {
      endpoint = parsed.endpoint.replace(/\/$/, '');
      apiKey = parsed.adminKey;
    }
  } catch {
    // Not JSON — fall through to shape #2.
  }

  // Shape #2 — separate secrets.
  if (!endpoint || !apiKey) {
    apiKey = adminRaw;
    if (!endpointArn) {
      throw new Error(
        'Azure Search admin secret is not unified-JSON; AZURE_SEARCH_ENDPOINT_SECRET_ARN required',
      );
    }
    const endpointRes = await sm.send(new GetSecretValueCommand({ SecretId: endpointArn }));
    endpoint = (endpointRes.SecretString ?? '').replace(/\/$/, '');
  }

  if (!endpoint || !apiKey) {
    throw new Error('Azure Search secrets empty — check Secrets Manager state');
  }
  return { endpoint, apiKey };
}

// Test hook to reset cache between tests.
export function __resetClientCacheForTests(): void {
  cached = new Map();
}
