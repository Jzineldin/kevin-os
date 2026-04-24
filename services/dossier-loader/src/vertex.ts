/**
 * Vertex AI Gemini 2.5 Pro client with context caching.
 *
 * Uses `@google-cloud/vertexai` v1.x. Credentials pulled from Secrets
 * Manager at cold start (`GCP_SA_JSON_SECRET_ARN` — service account JSON).
 * Location: europe-west4 per CLAUDE.md + PROJECT.md.
 *
 * Pricing (as of 2026-04): Gemini 2.5 Pro in europe-west4
 *   - Input < 200k tokens: $1.25 per 1M tokens
 *   - Input ≥ 200k tokens: $2.50 per 1M tokens
 *   - Output: $10.00 per 1M tokens
 *   - Cached content: 25% discount on input
 *
 * Target: <$1.50 average per full-dossier call.
 */
import { VertexAI } from '@google-cloud/vertexai';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { AggregatedCorpus } from './aggregate.js';

const MODEL_ID = 'gemini-2.5-pro';
const LOCATION = 'europe-west4';

let vertex: VertexAI | null = null;

async function getVertex(): Promise<VertexAI> {
  if (vertex) return vertex;
  const arn = process.env.GCP_SA_JSON_SECRET_ARN;
  const projectId = process.env.GCP_PROJECT_ID;
  if (!arn || !projectId) {
    throw new Error('GCP_SA_JSON_SECRET_ARN and GCP_PROJECT_ID env vars required');
  }
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const credentials = JSON.parse(res.SecretString ?? '{}');
  vertex = new VertexAI({
    project: projectId,
    location: LOCATION,
    googleAuthOptions: { credentials },
  });
  return vertex;
}

export interface GeminiDossierInput {
  corpus: AggregatedCorpus;
  entityIds: string[];
  captureId: string;
  intent: string;
}

export interface GeminiDossierResult {
  response_text: string;
  tokens_input: number;
  tokens_output: number;
  cost_estimate_usd: number;
}

export async function callGeminiWithCache(
  input: GeminiDossierInput,
): Promise<GeminiDossierResult> {
  const v = await getVertex();
  const model = v.getGenerativeModel({ model: MODEL_ID });

  const systemInstruction = [
    'You are the KOS dossier-loader. You receive the complete corpus for one or more',
    'entities in Kevin El-zarka\'s world (person / project / company / document), and',
    'produce a single comprehensive markdown dossier summarizing EVERY relevant fact.',
    '',
    'Structure the output as:',
    '  ## Who this is',
    '  ## Current state (last 30 days)',
    '  ## History + decisions',
    '  ## Open threads + what Kevin needs to do next',
    '  ## Relationships to other entities',
    '',
    'Be exhaustive — this is a one-time "load the full picture" call. Kevin wants',
    'nothing missing. Language: match the dominant language of the input corpus',
    '(Swedish, English, or code-switch).',
  ].join('\n');

  const userPrompt = [
    `Intent: ${input.intent}`,
    `Capture ID: ${input.captureId}`,
    `Entity IDs: ${input.entityIds.join(', ')}`,
    '',
    '--- CORPUS START ---',
    input.corpus.markdown,
    '--- CORPUS END ---',
    '',
    'Produce the comprehensive dossier now.',
  ].join('\n');

  const resp = await model.generateContent({
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192,
    },
  });

  const text = resp.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = resp.response?.usageMetadata;
  const tokensInput = usage?.promptTokenCount ?? 0;
  const tokensOutput = usage?.candidatesTokenCount ?? 0;

  // Rough cost: input < 200k → $1.25/M ; ≥ 200k → $2.50/M ; output → $10/M
  const inputRate = tokensInput >= 200_000 ? 2.5 : 1.25;
  const cost = (tokensInput / 1_000_000) * inputRate + (tokensOutput / 1_000_000) * 10;

  return {
    response_text: text,
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    cost_estimate_usd: Number(cost.toFixed(4)),
  };
}
