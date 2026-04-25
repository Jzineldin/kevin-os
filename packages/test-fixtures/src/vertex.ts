/**
 * Vertex AI Gemini 2.5 Pro fixture (Phase 6 Plan 06-00 Task 2).
 *
 * Used by `services/dossier-loader` unit tests to validate cachedContent
 * lifecycle + generateContent response handling without hitting Vertex
 * (no live cloud calls — see CLAUDE.md no-cloud-mutations rule).
 *
 * Shapes track the @google-cloud/vertexai v1.x types as of April 2026.
 */

export interface VertexCachedContentOverrides {
  name?: string;
  model?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  inputTokenCount?: number;
}

export interface VertexCachedContent {
  name: string;
  model: string;
  createTime: string;
  updateTime: string;
  expireTime: string;
  usageMetadata: {
    totalTokenCount: number;
  };
}

/**
 * Synthetic response from `cachedContents.create`. Default 24-h TTL per
 * D-21; `name` matches the Vertex `cachedContents/<id>` resource shape.
 */
export function fakeVertexCachedContent(
  overrides: VertexCachedContentOverrides = {},
): VertexCachedContent {
  const created = overrides.createTime ?? '2026-04-20T16:00:00.000Z';
  const expires = overrides.expireTime ?? '2026-04-21T16:00:00.000Z';
  return {
    name: overrides.name ?? 'cachedContents/abc123def456',
    model: overrides.model ?? 'projects/kos-vertex/locations/europe-west4/publishers/google/models/gemini-2.5-pro',
    createTime: created,
    updateTime: overrides.updateTime ?? created,
    expireTime: expires,
    usageMetadata: {
      totalTokenCount: overrides.inputTokenCount ?? 38_400,
    },
  };
}

export interface VertexResponseOverrides {
  text?: string;
  inputTokenCount?: number;
  outputTokenCount?: number;
  cachedContentTokenCount?: number;
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY';
}

export interface VertexResponse {
  candidates: Array<{
    content: {
      role: 'model';
      parts: Array<{ text: string }>;
    };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY';
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    cachedContentTokenCount: number;
  };
  modelVersion: string;
}

/**
 * Synthetic response from Vertex `generateContent`. Default text is a
 * one-paragraph entity dossier summary suitable for assembled_markdown.
 */
export function fakeVertexResponse(overrides: VertexResponseOverrides = {}): VertexResponse {
  const text =
    overrides.text ??
    'Damien Hateley — CTO partner i Outbehaving (Kevins side-project). Driver website redesign tillsammans med Simon Long. Senaste mötet 2026-04-20 om Almi Invest konvertibellån + bolagsstämma nästa fredag.';
  const promptTokens = overrides.inputTokenCount ?? 41_000;
  const candidateTokens = overrides.outputTokenCount ?? 320;
  const cachedTokens = overrides.cachedContentTokenCount ?? 38_400;
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason: overrides.finishReason ?? 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      totalTokenCount: promptTokens + candidateTokens,
      cachedContentTokenCount: cachedTokens,
    },
    modelVersion: 'gemini-2.5-pro',
  };
}
