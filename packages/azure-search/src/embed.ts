/**
 * Cohere v4 embedding helper (Bedrock eu-north-1).
 *
 * Phase 6: each indexer + dossier write needs a vector to insert alongside
 * the searchable text fields. Shares model ID convention with @kos/resolver
 * (EMBED_MODEL_ID = 'eu.cohere.embed-v4:0'; dim 1024).
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const EMBED_MODEL_ID = 'eu.cohere.embed-v4:0';
const EMBED_DIM = 1024;

let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  }
  return client;
}

export interface EmbedInput {
  text: string;
  inputType: 'search_document' | 'search_query' | 'classification' | 'clustering';
}

export async function embedText(input: EmbedInput): Promise<number[]> {
  const body = {
    texts: [input.text],
    input_type: input.inputType,
    embedding_types: ['float'],
    output_dimension: EMBED_DIM,
  };
  const res = await getClient().send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  const vec = decoded?.embeddings?.float?.[0];
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(
      `Unexpected Cohere v4 response shape: expected float[${EMBED_DIM}], got ${JSON.stringify(decoded).slice(0, 200)}`,
    );
  }
  return vec as number[];
}

export { EMBED_MODEL_ID, EMBED_DIM };
