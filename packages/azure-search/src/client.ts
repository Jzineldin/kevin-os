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

let cached: Map<string, SearchClient<unknown>> = new Map();

export async function getAzureSearchClient<T = unknown>(
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
  cached.set(cacheKey, client as unknown as SearchClient<unknown>);
  return client;
}

async function loadConfig(): Promise<{ endpoint: string; apiKey: string }> {
  const endpointArn = process.env.AZURE_SEARCH_ENDPOINT_SECRET_ARN;
  const adminArn = process.env.AZURE_SEARCH_ADMIN_SECRET_ARN;
  if (!endpointArn || !adminArn) {
    throw new Error(
      'AZURE_SEARCH_ENDPOINT_SECRET_ARN and AZURE_SEARCH_ADMIN_SECRET_ARN env vars required',
    );
  }
  const sm = new SecretsManagerClient({});
  const [endpointRes, adminRes] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: endpointArn })),
    sm.send(new GetSecretValueCommand({ SecretId: adminArn })),
  ]);
  const endpoint = endpointRes.SecretString?.replace(/\/$/, '') ?? '';
  const apiKey = adminRes.SecretString ?? '';
  if (!endpoint || !apiKey) {
    throw new Error('Azure Search secrets empty — check Secrets Manager state');
  }
  return { endpoint, apiKey };
}

// Test hook to reset cache between tests.
export function __resetClientCacheForTests(): void {
  cached = new Map();
}
