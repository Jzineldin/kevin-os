/**
 * Shared Sentry init for every Phase 2 Lambda (D-26).
 *
 * Single source of truth for Sentry wiring. Each service imports via relative
 * path (`../../_shared/sentry.js`) — kept as a standalone TypeScript module
 * (NOT a workspace package) per the Plan 02-00 _shared layout decision.
 *
 * DSN is fetched ONCE per cold start from Secrets Manager
 * (SENTRY_DSN_SECRET_ARN). Cached in module scope. If the secret value is
 * empty / 'PLACEHOLDER' / the secret simply doesn't exist, init silently
 * degrades — running the Lambda WITHOUT Sentry is always preferable to
 * blocking the handler on observability infrastructure (Pitfall 9 spirit
 * applied to error tracking).
 *
 * Usage:
 *   import { initSentry, wrapHandler } from '../../_shared/sentry.js';
 *   await initSentry();                   // call at handler entry
 *   export const handler = wrapHandler(async (e) => { ... });
 *
 * `wrapHandler` is re-exported from @sentry/aws-serverless verbatim so callers
 * don't need a second import for the wrap. `Sentry` (the namespace) is also
 * re-exported for the rare case a Lambda wants to call `Sentry.captureMessage`
 * or attach a tag manually.
 */
import * as Sentry from '@sentry/aws-serverless';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let initialised = false;

/**
 * Initialise Sentry at cold start. Idempotent — safe to call multiple times.
 * DSN fetched from Secrets Manager the first time; cached in module scope.
 *
 * Graceful degradation: if SENTRY_DSN_SECRET_ARN is unset, the secret is
 * empty, or the literal string 'PLACEHOLDER' (DataStack seeds secrets with
 * this), we mark initialised=true and return — the Lambda runs without
 * Sentry rather than crashing the cold start on missing observability.
 *
 * Sentry init failures are also swallowed: a misconfigured DSN must not kill
 * a real user-facing Lambda invocation.
 */
export async function initSentry(): Promise<void> {
  if (initialised) return;
  const arn = process.env['SENTRY_DSN_SECRET_ARN'];
  if (!arn) {
    initialised = true;
    return;
  }
  try {
    const sm = new SecretsManagerClient({
      region: process.env['AWS_REGION'] ?? 'eu-north-1',
    });
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    const dsn = r.SecretString;
    if (!dsn || dsn === 'PLACEHOLDER') {
      initialised = true;
      return;
    }
    Sentry.init({
      dsn,
      environment: process.env['KOS_ENV'] ?? 'prod',
      // Errors only — distributed traces live in Langfuse (D-25). tracesSampleRate
      // = 0 keeps Sentry's free-tier 5k events/month budget for actual errors
      // (T-02-OBS-02 mitigation).
      tracesSampleRate: 0.0,
      sampleRate: 1.0,
      beforeBreadcrumb: (bc: { data?: Record<string, unknown> }) => {
        // Scrub any breadcrumb whose data has a key that smells like a token.
        // Cheap belt-and-braces in case a downstream lib accidentally
        // breadcrumbs an auth header.
        if (bc.data) {
          for (const k of Object.keys(bc.data)) {
            if (/TOKEN|SECRET|KEY/i.test(k)) delete bc.data[k];
          }
        }
        return bc;
      },
    });
  } catch {
    // Sentry init failure MUST NOT kill the Lambda. We swallow + carry on.
  }
  initialised = true;
}

/** Test-only hook to reset module state between tests. */
export function __resetSentryForTests(): void {
  initialised = false;
}

export const wrapHandler = Sentry.wrapHandler;
export { Sentry };
