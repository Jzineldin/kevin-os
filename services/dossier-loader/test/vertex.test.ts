/**
 * vertex.test.ts — Vertex Gemini 2.5 Pro client wrapper tests.
 *
 * Phase 6 Plan 06-05 Task 3 (INF-10).
 *
 * Strategy: mock both `@google-cloud/vertexai` and `@aws-sdk/client-secrets-manager`
 * to assert the client is constructed with europe-west4 location, project id, and
 * SA-JSON credentials pulled from Secrets Manager. Cost estimation is asserted
 * via the response usage path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const vertexConstructor = vi.fn();
const generateContent = vi.fn();
const getGenerativeModel = vi.fn(() => ({ generateContent }));

vi.mock('@google-cloud/vertexai', () => ({
  VertexAI: vi.fn().mockImplementation((config: unknown) => {
    vertexConstructor(config);
    return { getGenerativeModel };
  }),
}));

const sendMock = vi.fn().mockResolvedValue({
  SecretString: JSON.stringify({
    project_id: 'kos-vertex-prod',
    private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
    client_email: 'kos-sa@kos-vertex-prod.iam.gserviceaccount.com',
  }),
});
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

beforeEach(() => {
  vertexConstructor.mockClear();
  getGenerativeModel.mockClear();
  generateContent.mockClear();
  sendMock.mockClear();
  process.env.GCP_SA_JSON_SECRET_ARN = 'arn:aws:secretsmanager:eu-north-1:123:secret:kos/gcp-vertex-sa';
  process.env.GCP_PROJECT_ID = 'kos-vertex-prod';
  process.env.AWS_REGION = 'eu-north-1';
  vi.resetModules();
});

describe('callGeminiWithCache', () => {
  it('constructs VertexAI client with europe-west4 location + SA credentials from Secrets Manager', async () => {
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [
          {
            content: { parts: [{ text: '## Damien dossier...\nFull picture here.' }] },
          },
        ],
        usageMetadata: { promptTokenCount: 50_000, candidatesTokenCount: 1_500 },
      },
    });

    const { callGeminiWithCache } = await import('../src/vertex.js');
    const result = await callGeminiWithCache({
      corpus: { markdown: '# Entity\n', chars: 10, sections: 1, truncated: false },
      entityIds: ['11111111-1111-1111-1111-111111111111'],
      captureId: 'test-cap-1',
      intent: 'load full dossier for Damien',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(vertexConstructor).toHaveBeenCalledTimes(1);
    const cfg = vertexConstructor.mock.calls[0]![0] as {
      project: string;
      location: string;
      googleAuthOptions: { credentials: { project_id: string } };
    };
    expect(cfg.project).toBe('kos-vertex-prod');
    expect(cfg.location).toBe('europe-west4');
    expect(cfg.googleAuthOptions.credentials.project_id).toBe('kos-vertex-prod');
    expect(getGenerativeModel).toHaveBeenCalledWith({ model: 'gemini-2.5-pro' });
    expect(result.response_text).toContain('Damien dossier');
    expect(result.tokens_input).toBe(50_000);
    expect(result.tokens_output).toBe(1_500);
  });

  it('cost estimate uses $1.25/M input under 200k + $10/M output', async () => {
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'short' }] } }],
        usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 1_000 },
      },
    });

    const { callGeminiWithCache } = await import('../src/vertex.js');
    const result = await callGeminiWithCache({
      corpus: { markdown: '# x', chars: 3, sections: 1, truncated: false },
      entityIds: ['11111111-1111-1111-1111-111111111111'],
      captureId: 'cap-2',
      intent: 'q',
    });

    // 100k * $1.25/M + 1k * $10/M = 0.125 + 0.01 = 0.135
    expect(result.cost_estimate_usd).toBeCloseTo(0.135, 3);
  });

  it('cost estimate uses $2.50/M when input >= 200k', async () => {
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'big' }] } }],
        usageMetadata: { promptTokenCount: 300_000, candidatesTokenCount: 2_000 },
      },
    });

    const { callGeminiWithCache } = await import('../src/vertex.js');
    const result = await callGeminiWithCache({
      corpus: { markdown: '# x', chars: 3, sections: 1, truncated: false },
      entityIds: ['11111111-1111-1111-1111-111111111111'],
      captureId: 'cap-3',
      intent: 'q',
    });

    // 300k * $2.50/M + 2k * $10/M = 0.75 + 0.02 = 0.77
    expect(result.cost_estimate_usd).toBeCloseTo(0.77, 3);
  });

  it('passes systemInstruction with KOS dossier-loader role', async () => {
    generateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    });

    const { callGeminiWithCache } = await import('../src/vertex.js');
    await callGeminiWithCache({
      corpus: { markdown: '# Entity\nbody', chars: 14, sections: 1, truncated: false },
      entityIds: ['11111111-1111-1111-1111-111111111111'],
      captureId: 'cap-4',
      intent: 'load Damien dossier',
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const args = generateContent.mock.calls[0]![0] as {
      systemInstruction: { role: string; parts: { text: string }[] };
      contents: Array<{ role: string; parts: { text: string }[] }>;
    };
    expect(args.systemInstruction.role).toBe('system');
    expect(args.systemInstruction.parts[0]!.text).toContain('KOS dossier-loader');
    expect(args.contents[0]!.role).toBe('user');
    expect(args.contents[0]!.parts[0]!.text).toContain('Intent: load Damien dossier');
    // WR-02 hardening: untrusted corpus is wrapped in <corpus>...</corpus>
    // delimiters (prompt-injection mitigation, T-06-EXTRACTOR-01).
    expect(args.contents[0]!.parts[0]!.text).toContain('<corpus>');
    expect(args.contents[0]!.parts[0]!.text).toContain('</corpus>');
  });

  it('throws actionable error when GCP_SA_JSON_SECRET_ARN env missing', async () => {
    delete process.env.GCP_SA_JSON_SECRET_ARN;
    const { callGeminiWithCache } = await import('../src/vertex.js');
    await expect(
      callGeminiWithCache({
        corpus: { markdown: '# x', chars: 3, sections: 1, truncated: false },
        entityIds: ['11111111-1111-1111-1111-111111111111'],
        captureId: 'cap-5',
        intent: 'q',
      }),
    ).rejects.toThrow(/GCP_SA_JSON_SECRET_ARN/);
  });
});
