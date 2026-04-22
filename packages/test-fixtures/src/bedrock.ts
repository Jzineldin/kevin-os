/**
 * Mock BedrockRuntimeClient supporting InvokeModel response shaping
 * for Claude Agent SDK (Haiku/Sonnet) and Cohere Embed Multilingual v3.
 *
 * Detection: modelId containing "cohere" returns an embeddings payload;
 * anything else returns a Claude-style content[] body.
 */
export interface MockBedrockOptions {
  /** Deterministic response for Claude invocations (raw text, typically JSON). */
  claudeResponse?: string;
  /** 1024-dim embeddings returned for Cohere calls. */
  embeddings?: number[][];
}

export interface MockBedrockClient {
  send: (cmd: unknown) => Promise<unknown>;
}

export function mockBedrockClient(opts: MockBedrockOptions = {}): MockBedrockClient {
  const embeddings = opts.embeddings ?? [new Array(1024).fill(0)];
  return {
    send: async (cmd: unknown) => {
      const input = (cmd as { input?: { body?: Uint8Array; modelId?: string } }).input ?? {};
      const modelId = String(input.modelId ?? '');
      if (modelId.includes('cohere')) {
        const body = JSON.stringify({ embeddings: { float: embeddings }, id: 'mock', texts: [] });
        return { body: new TextEncoder().encode(body) };
      }
      // Claude (Haiku 4.5 / Sonnet 4.6 via Bedrock InvokeModel)
      const text = opts.claudeResponse ?? '{"route":"voice-capture"}';
      return {
        body: new TextEncoder().encode(
          JSON.stringify({
            content: [{ type: 'text', text }],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        ),
      };
    },
  };
}
