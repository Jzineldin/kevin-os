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
import { trace } from '@opentelemetry/api';

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
  // LangfuseSpanProcessor's structural span shape can drift across the
  // sdk-trace-base v1↔v2 boundary depending on which peer the consuming
  // service resolves (services with @sentry/aws-serverless's @sentry/node
  // → @sentry/opentelemetry chain pin OTel core to v1.30.1; services that
  // resolve langfuse/otel against v2 see the v2 SpanProcessor type). The
  // runtime contract is correct in both cases. Cast through unknown to
  // unblock typecheck across the entire fleet — same pattern the existing
  // ClaudeAgentSDKInstrumentation cast below uses.
  tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: process.env['LANGFUSE_BASE_URL'] ?? 'https://cloud.langfuse.com',
      }) as unknown as never,
    ],
  });
  tracerProvider.register();
  // ClaudeAgentSDKInstrumentation typing drifts vs core OTel Instrumentation
  // shape across versions; the runtime contract is correct. Cast to unknown.
  registerInstrumentations({
    instrumentations: [new ClaudeAgentSDKInstrumentation() as unknown as never],
  });
}

export async function flush(): Promise<void> {
  if (!tracerProvider) return;
  const flushPromise = tracerProvider.forceFlush().catch(() => {});
  const timeout = new Promise<void>((r) => setTimeout(r, 2000));
  await Promise.race([flushPromise, timeout]);
}

/**
 * Tag the active OTel span with the KOS capture_id so cross-agent invocations
 * (triage → voice-capture → entity-resolver) correlate in Langfuse as a single
 * session. Called inside the handler's try block AFTER the idempotency check
 * so every Bedrock call inside the agent SDK invocation inherits the tag from
 * the parent span.
 *
 * Sets three attributes:
 *   - kos.capture_id        — KOS-native key (greppable in any backend)
 *   - langfuse.trace.id     — Langfuse convention so traces group on capture_id
 *   - langfuse.session.id   — Langfuse session grouping (Plan 02-10 verify
 *                             script queries `?sessionId=<capture_id>`)
 *
 * No-op when no active span exists (e.g. when Langfuse env vars are absent
 * and setupOtelTracing() returned early). Safe to call unconditionally.
 */
export function tagTraceWithCaptureId(captureId: string): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('kos.capture_id', captureId);
  span.setAttribute('langfuse.trace.id', captureId);
  span.setAttribute('langfuse.session.id', captureId);
}
