/**
 * Langfuse OTel wiring for Claude Agent SDK + Bedrock observability (D-25).
 *
 * Single source of truth for Langfuse wiring. Each agent service imports this
 * file via relative path (`../../_shared/tracing.js`). Kept as a standalone
 * TypeScript module — NOT a workspace package — to avoid an extra
 * @kos/tracing indirection during Wave 0 scaffolding.
 *
 * Usage:
 *   import { setupOtelTracing, flush } from '../../_shared/tracing.js';
 *   setupOtelTracing();               // call at cold start
 *   // ... agent invocation ...
 *   await flush();                    // await before Lambda returns
 *
 * Pitfall 9 mitigation: `flush()` races against a 2s timeout so a Langfuse
 * cloud outage cannot block Lambda return (which would otherwise convert
 * observability dependency into hot-path latency + DLQ noise).
 */
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

let tracerProvider: NodeTracerProvider | null = null;

export function setupOtelTracing(): void {
  if (tracerProvider) return;
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  if (!publicKey || !secretKey) {
    // Graceful degradation: run without Langfuse if secrets not seeded yet.
    // Logged once at cold start so we notice in CloudWatch if env drift hides the keys.
    // eslint-disable-next-line no-console
    console.warn('[tracing] LANGFUSE_PUBLIC_KEY/SECRET_KEY missing; skipping Langfuse wiring');
    return;
  }
  tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: process.env['LANGFUSE_BASE_URL'] ?? 'https://cloud.langfuse.com',
      }),
    ],
  });
  tracerProvider.register();
  registerInstrumentations({ instrumentations: [new ClaudeAgentSDKInstrumentation()] });
}

export async function flush(): Promise<void> {
  if (!tracerProvider) return;
  const flushPromise = tracerProvider.forceFlush().catch(() => {});
  const timeout = new Promise<void>((r) => setTimeout(r, 2000));
  await Promise.race([flushPromise, timeout]);
}
