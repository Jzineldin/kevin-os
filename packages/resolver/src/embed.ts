import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// 2026-04-22 (Wave 5 Gap A): migrated from `cohere.embed-multilingual-v3`
// (not available in eu-north-1 Bedrock) to Cohere Embed v4 via the EU
// inference profile. v4 keeps the same request/response schema for text
// embedding; the only addition is `output_dimension` (256/512/1024/1536),
// which we pin to 1024 to keep Postgres `vector(1024)` + Azure index dims
// stable from migration 0003 (D-06).
export const MODEL_ID = 'eu.cohere.embed-v4:0';
const COHERE_MAX_INPUTS = 96; // Cohere API hard limit (v3 + v4)
const COHERE_MAX_CHAR_WARN = 2000; // rough proxy for 512 tokens

let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return client;
}

export type EmbedInputType = 'search_document' | 'search_query';

/**
 * Cohere Embed v4 on Bedrock (EU inference profile). 1024-dim floats
 * pinned via `output_dimension`, max 96 texts, 512 tokens per text.
 * Explicitly sets `truncate: 'END'` (Pitfall 3) to avoid errors on long inputs.
 */
export async function embedBatch(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > COHERE_MAX_INPUTS) {
    throw new Error(`embedBatch received ${texts.length} texts; Cohere v4 max is ${COHERE_MAX_INPUTS}`);
  }
  for (const t of texts) {
    if (t.length > COHERE_MAX_CHAR_WARN) {
      console.warn(`[embed] input length ${t.length} chars (~>512 tokens); will be truncated END`);
    }
  }
  const body = {
    texts,
    input_type: inputType,
    truncate: 'END' as const,
    embedding_types: ['float'] as const,
    output_dimension: 1024,
  };
  const resp = await getClient().send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(body)),
    }),
  );
  const decoded = JSON.parse(new TextDecoder().decode(resp.body)) as {
    embeddings: { float: number[][] };
  };
  if (!Array.isArray(decoded.embeddings?.float) || decoded.embeddings.float.length !== texts.length) {
    throw new Error('cohere embed response malformed');
  }
  for (const vec of decoded.embeddings.float) {
    if (vec.length !== 1024) throw new Error(`cohere returned ${vec.length}-dim vector; expected 1024`);
  }
  return decoded.embeddings.float;
}

/**
 * D-08 entity text = Name | Aliases | SeedContext | Role | Org | Relationship (max 8k chars input).
 * Prioritized Name+Aliases first so truncation preserves identity cues.
 */
export function buildEntityEmbedText(e: {
  name: string;
  aliases: string[] | null;
  seedContext: string | null;
  role: string | null;
  org: string | null;
  relationship: string | null;
}): string {
  const parts = [
    e.name,
    (e.aliases ?? []).join(', '),
    e.role ?? '',
    e.org ?? '',
    e.relationship ?? '',
    e.seedContext ?? '',
  ].filter((p) => p.length > 0);
  return parts.join(' | ').slice(0, 8000);
}
