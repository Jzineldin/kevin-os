#!/usr/bin/env node
/**
 * Plan 01-05 Gate 1 verifier — asserts the live `kos-memory-v1` index exists
 * on Azure AI Search with binary quantization, preserveOriginals rescoring,
 * and the `kos-semantic` configuration.
 *
 * Usage:
 *   node scripts/verify-azure-index.mjs
 *
 * Prereqs:
 *   - `scripts/provision-azure-search.sh` has run (Secrets Manager seeded)
 *   - `cdk deploy KosIntegrations` has completed (index PUT'd)
 *   - AWS creds in current shell can GetSecretValue on kos/azure-search-admin
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — GET /indexes/kos-memory-v1 failed
 *   2 — compressions[0].kind !== 'binaryQuantization'
 *   3 — rescoreStorageMethod !== 'preserveOriginals'
 *   4 — semantic config kos-semantic missing
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const AWS_REGION = process.env.AWS_REGION ?? 'eu-north-1';
const sm = new SecretsManagerClient({ region: AWS_REGION });

const sec = await sm.send(
  new GetSecretValueCommand({ SecretId: 'kos/azure-search-admin' }),
);
if (!sec.SecretString) {
  console.error('[FAIL] kos/azure-search-admin has no SecretString');
  process.exit(1);
}
const { endpoint, adminKey } = JSON.parse(sec.SecretString);
if (!endpoint || !adminKey) {
  console.error(
    '[FAIL] Secret missing endpoint/adminKey — run scripts/provision-azure-search.sh',
  );
  process.exit(1);
}

const url = `${endpoint}/indexes/kos-memory-v1?api-version=2025-09-01`;
const res = await fetch(url, { headers: { 'api-key': adminKey } });
if (!res.ok) {
  console.error('[FAIL] GET failed', res.status, await res.text());
  process.exit(1);
}
const idx = await res.json();

const kind = idx?.vectorSearch?.compressions?.[0]?.kind;
if (kind !== 'binaryQuantization') {
  console.error('[FAIL] binary quantization missing; got', kind);
  process.exit(2);
}

const rescore =
  idx?.vectorSearch?.compressions?.[0]?.rescoringOptions?.rescoreStorageMethod;
if (rescore !== 'preserveOriginals') {
  console.error('[FAIL] rescoreStorageMethod wrong:', rescore);
  process.exit(3);
}

const sem = idx?.semantic?.configurations?.[0]?.name;
if (sem !== 'kos-semantic') {
  console.error('[FAIL] semantic config missing; got', sem);
  process.exit(4);
}

console.log(
  '[OK] binary quantization + preserveOriginals + kos-semantic verified on kos-memory-v1',
);
