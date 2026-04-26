/**
 * chrome-webhook wiring helper for IntegrationsStack (Phase 5 / Plan 05-01 — CAP-04).
 *
 * Mirrors `integrations-ios-webhook.ts` but lighter:
 *   - KosLambda outside the VPC (D-05; Bearer + HMAC are the auth boundary).
 *   - Lambda Function URL with authType=NONE per D-02.
 *   - NO replay-cache table (Plan 05-01 accepts replay risk for v1 — the
 *     ±300s drift window + a server-minted ULID are sufficient; the
 *     dashboard's capture_id-dedupe absorbs accidental double-clicks).
 *   - NO S3 grants (chrome highlights are pure text events; no audio,
 *     no images, no attachments).
 *
 * IAM grants:
 *   - SecretsManager Read on the Bearer + HMAC secrets only.
 *   - EventBridge PutEvents on the kos.capture bus.
 *   - Sentry/Langfuse secret reads (D-28) when the optional secrets are wired.
 *
 * Operator runbook (post-deploy):
 *   1. `aws secretsmanager put-secret-value --secret-id kos/chrome-extension-bearer  --secret-string "$(openssl rand -hex 32)"`
 *   2. `aws secretsmanager put-secret-value --secret-id kos/chrome-extension-hmac-secret --secret-string "$(openssl rand -hex 32)"`
 *   3. Read the Function URL from CFN outputs (`KosChromeWebhookUrl`).
 *   4. Open the unpacked Chrome extension → Options page → paste all three.
 */
import { Duration, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireChromeWebhookProps {
  /** EventBridge `kos.capture` bus — Lambda emits `capture.received` events. */
  captureBus: EventBus;
  /** kos/chrome-extension-bearer (DataStack-managed placeholder). */
  chromeExtensionBearerSecret: ISecret;
  /** kos/chrome-extension-hmac-secret (DataStack-managed placeholder). */
  chromeExtensionHmacSecret: ISecret;
  /** Optional D-28 secrets — wired into env when supplied. */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface ChromeWebhookWiring {
  webhookFunction: KosLambda;
  webhookUrl: string;
}

/**
 * Provision the chrome-webhook Lambda + Function URL + IAM grants.
 *
 * Memory: 512 MB — handler is pure CPU + a single PutEvents; 256 MB would
 * suffice but 512 MB matches the rest of the capture-ingress fleet for
 * predictable cold-start time.
 *
 * Timeout: 15 s — same as iOS to keep operator mental-model uniform.
 */
export function wireChromeWebhook(
  scope: Construct,
  props: WireChromeWebhookProps,
): ChromeWebhookWiring {
  const fn = new KosLambda(scope, 'ChromeWebhook', {
    entry: svcEntry('chrome-webhook'),
    timeout: Duration.seconds(15),
    memory: 512,
    environment: {
      CHROME_BEARER_SECRET_ARN: props.chromeExtensionBearerSecret.secretArn,
      CHROME_HMAC_SECRET_ARN: props.chromeExtensionHmacSecret.secretArn,
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
      ...(props.langfusePublicKeySecret
        ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: props.langfusePublicKeySecret.secretArn }
        : {}),
      ...(props.langfuseSecretKeySecret
        ? { LANGFUSE_SECRET_KEY_SECRET_ARN: props.langfuseSecretKeySecret.secretArn }
        : {}),
    },
  });

  // --- IAM grants ---------------------------------------------------------
  props.chromeExtensionBearerSecret.grantRead(fn);
  props.chromeExtensionHmacSecret.grantRead(fn);
  props.captureBus.grantPutEventsTo(fn);
  props.sentryDsnSecret?.grantRead(fn);
  props.langfusePublicKeySecret?.grantRead(fn);
  props.langfuseSecretKeySecret?.grantRead(fn);

  // --- Function URL --------------------------------------------------------
  // authType=NONE per D-02. Bearer + HMAC IS the auth boundary; Lambda IAM
  // auth would require the Chrome extension to sign SigV4 (it can't, and
  // even if it could the signing key would have to live in chrome.storage).
  const url = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
  });

  new CfnOutput(scope, 'ChromeWebhookUrl', {
    value: url.url,
    exportName: 'KosChromeWebhookUrl',
    description: 'Chrome extension highlight webhook (CAP-04)',
  });

  return { webhookFunction: fn, webhookUrl: url.url };
}
