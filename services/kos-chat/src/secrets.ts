/**
 * Cold-start secret loader for kos-chat Lambda.
 *
 * Pattern: store ARN in env var, fetch secret value once per cold start,
 * cache in module scope. Lambda VPC has no Secrets Manager VPC endpoint,
 * but Lambdas have internet-egress via NAT (same as every other agent).
 *
 * NOTION_TOKEN is loaded from NOTION_TOKEN env var if present (set by CDK
 * via SecretValue.unsafePlainText — not ideal but matches how other agent
 * Lambdas do it). Falls back to Secrets Manager ARN.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? 'eu-north-1',
});

async function fetchSecret(arn: string): Promise<string> {
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const val = resp.SecretString ?? '';
  return val;
}

let cachedBearer: string | null = null;
export async function getChatBearerToken(): Promise<string | null> {
  if (cachedBearer !== null) return cachedBearer;
  const arn = process.env.KOS_CHAT_BEARER_SECRET_ARN;
  if (!arn) return null; // Unset in dev — open access
  try {
    cachedBearer = await fetchSecret(arn);
    return cachedBearer;
  } catch {
    return null;
  }
}

let cachedNotionToken: string | null = null;
export async function getNotionToken(): Promise<string> {
  if (cachedNotionToken !== null) return cachedNotionToken;
  const direct = process.env.NOTION_TOKEN;
  if (direct && direct !== 'PLACEHOLDER') {
    cachedNotionToken = direct;
    return cachedNotionToken;
  }
  const arn = process.env.NOTION_TOKEN_SECRET_ARN;
  if (!arn) throw new Error('[kos-chat] Neither NOTION_TOKEN nor NOTION_TOKEN_SECRET_ARN is set');
  cachedNotionToken = await fetchSecret(arn);
  return cachedNotionToken;
}
