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
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let tracerProvider: NodeTracerProvider | null = null;
let setupPromise: Promise<void> | null = null;

const secretsClient = new SecretsManagerClient({});

async function fetchSecret(arn: string | undefined): Promise<string | undefined> {
  if (!arn) return undefined;
  try {
    const r = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
    const v = r.SecretString;
    if (!v || v === 'PLACEHOLDER') return undefined;
    return v;
  } catch {
    return undefined;
  }
}

/**
 * Async setup. Resolves Langfuse public/secret keys from
 * `LANGFUSE_PUBLIC_KEY_SECRET_ARN` / `LANGFUSE_SECRET_KEY_SECRET_ARN` first
 * (the CDK plumbing pattern), then falls back to literal `LANGFUSE_PUBLIC_KEY`
 * / `LANGFUSE_SECRET_KEY` env vars (local-test convenience). Cached via
 * module-scope promise so concurrent invocations all share the single
 * Secrets Manager round-trip.
 */
export async function setupOtelTracingAsync(): Promise<void> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    if (tracerProvider) return;
    const [secretArnPub, secretArnSec] = [
      await fetchSecret(process.env['LANGFUSE_PUBLIC_KEY_SECRET_ARN']),
      await fetchSecret(process.env['LANGFUSE_SECRET_KEY_SECRET_ARN']),
    ];
    const publicKey = secretArnPub ?? process.env['LANGFUSE_PUBLIC_KEY'];
    const secretKey = secretArnSec ?? process.env['LANGFUSE_SECRET_KEY'];
    if (!publicKey || !secretKey) {
      // eslint-disable-next-line no-console
      console.warn(
        '[tracing] Langfuse keys missing (neither *_SECRET_ARN nor literal env var resolves); skipping Langfuse wiring',
      );
      return;
    }
    initTracerProvider(publicKey, secretKey);
  })();
  return setupPromise;
}

/**
 * Sync entry point retained for backwards compat with handlers that call it
 * at cold start. Defers to the literal-env-var path only — async secret
 * resolution requires `setupOtelTracingAsync()`. Call the async version
 * from the handler entry instead.
 */
export function setupOtelTracing(): void {
  if (tracerProvider) return;
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  if (!publicKey || !secretKey) {
    // eslint-disable-next-line no-console
    console.warn('[tracing] LANGFUSE_PUBLIC_KEY/SECRET_KEY missing; skipping Langfuse wiring (use setupOtelTracingAsync to resolve from Secrets Manager)');
    return;
  }
  initTracerProvider(publicKey, secretKey);
}

function initTracerProvider(publicKey: string, secretKey: string): void {
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
