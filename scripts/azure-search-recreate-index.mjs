#!/usr/bin/env node
// Recreate Azure AI Search index kos-memory-v1 with 1024-dim vector field.
// D-06: zero-document migration — we delete then recreate.
// Idempotent: if index already at 1024 dims, exits 0 without action.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const region = process.env.AWS_REGION ?? 'eu-north-1';
const sm = new SecretsManagerClient({ region });
const adminKey = (await sm.send(new GetSecretValueCommand({ SecretId: 'kos/azure-search-admin' }))).SecretString;
const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
if (!endpoint) { console.error('AZURE_SEARCH_ENDPOINT env required'); process.exit(1); }

const INDEX_NAME = 'kos-memory-v1';
const apiVersion = '2025-09-01';
const headers = { 'api-key': adminKey, 'content-type': 'application/json' };

// 1. Check existing dims
const getRes = await fetch(`${endpoint}/indexes/${INDEX_NAME}?api-version=${apiVersion}`, { headers });
if (getRes.ok) {
  const body = await getRes.json();
  const vec = body.fields.find((f) => f.type === 'Collection(Edm.Single)');
  if (vec?.dimensions === 1024) { console.log('[OK] index already 1024 dims'); process.exit(0); }
  // Check doc count before delete
  const countRes = await fetch(`${endpoint}/indexes/${INDEX_NAME}/docs/$count?api-version=${apiVersion}`, { headers });
  const count = Number(await countRes.text());
  if (count > 0) { console.error(`[ERR] index has ${count} docs; refusing destructive delete`); process.exit(1); }
  console.log(`[*] deleting existing index (${vec?.dimensions ?? '?'} dims, 0 docs)`);
  const delRes = await fetch(`${endpoint}/indexes/${INDEX_NAME}?api-version=${apiVersion}`, { method: 'DELETE', headers });
  if (!delRes.ok) { console.error(await delRes.text()); process.exit(1); }
}

// 2. Create with 1024 dims + binary quantization (preserve Phase 1 cost decision)
const indexDef = {
  name: INDEX_NAME,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true },
    { name: 'content', type: 'Edm.String', searchable: true },
    { name: 'entityId', type: 'Edm.String', filterable: true },
    { name: 'ownerId', type: 'Edm.String', filterable: true },
    { name: 'source', type: 'Edm.String', filterable: true },
    {
      name: 'contentVector', type: 'Collection(Edm.Single)', searchable: true,
      dimensions: 1024,
      vectorSearchProfile: 'kos-hnsw-binary-profile',
      stored: true,
    },
  ],
  vectorSearch: {
    profiles: [{
      name: 'kos-hnsw-binary-profile',
      algorithm: 'kos-hnsw',
      compression: 'kos-binary-quant',
    }],
    algorithms: [{
      name: 'kos-hnsw', kind: 'hnsw',
      hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' },
    }],
    compressions: [{
      name: 'kos-binary-quant', kind: 'binaryQuantization',
      rescoringOptions: { enableRescoring: true, defaultOversampling: 10 },
    }],
  },
  semantic: {
    defaultConfiguration: 'default',
    configurations: [{ name: 'default', prioritizedFields: { prioritizedContentFields: [{ fieldName: 'content' }] } }],
  },
};
const createRes = await fetch(`${endpoint}/indexes?api-version=${apiVersion}`, {
  method: 'POST', headers, body: JSON.stringify(indexDef),
});
if (!createRes.ok) { console.error(await createRes.text()); process.exit(1); }
console.log('[OK] index recreated at 1024 dims with binary quantization');
