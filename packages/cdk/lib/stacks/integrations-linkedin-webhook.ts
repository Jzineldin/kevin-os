/**
 * LinkedIn DM webhook wiring helper for IntegrationsStack (Plan 05-02 / CAP-05).
 *
 * Mirrors `integrations-ios-webhook.ts` shape, with two-secret auth (Bearer +
 * HMAC) instead of one (HMAC-only):
 *   - KosLambda (outside the VPC; Bearer + HMAC are the auth boundary)
 *   - Lambda Function URL (authType=NONE; HMAC + Bearer are the only gates)
 *   - Two Secrets Manager entries:
 *       kos/linkedin-webhook-bearer
 *       kos/linkedin-webhook-hmac
 *   - IAM grants:
 *       secretsmanager:GetSecretValue on both secrets,
 *       events:PutEvents on the kos.capture bus
 *
 * NO bedrock:* / ses:* / dynamodb:* — defence-in-depth verified by the
 * `integrations-linkedin-webhook.test.ts` synth assertions.
 *
 * Operator runbook (post-deploy, before the Chrome extension goes live):
 *   1. Seed both secrets:
 *        aws secretsmanager put-secret-value \
 *          --secret-id kos/linkedin-webhook-bearer \
 *          --secret-string "$(openssl rand -hex 24)"
 *        aws secretsmanager put-secret-value \
 *          --secret-id kos/linkedin-webhook-hmac \
 *          --secret-string "$(openssl rand -hex 32)"
 *   2. Read the Function URL from CFN outputs (`KosLinkedInWebhookUrl`).
 *   3. Paste { webhookUrl, bearer, hmacSecret } into the extension options
 *      page (apps/chrome-extension/src/options.html).
 */
import { Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireLinkedInWebhookProps {
  /** EventBridge `kos.capture` bus — Lambda emits `capture.received` events. */
  captureBus: EventBus;
  /** Optional Sentry DSN secret — wired into the Lambda env if provided. */
  sentryDsnSecret?: ISecret;
  /** Optional Langfuse public-key secret. */
  langfusePublicKeySecret?: ISecret;
  /** Optional Langfuse secret-key secret. */
  langfuseSecretKeySecret?: ISecret;
}

export interface LinkedInWebhookWiring {
  webhookFunction: KosLambda;
  webhookUrl: string;
  bearerSecret: Secret;
  hmacSecret: Secret;
}

export function wireLinkedInWebhook(
  scope: Construct,
  props: WireLinkedInWebhookProps,
): LinkedInWebhookWiring {
  // --- Secrets Manager: Bearer + HMAC ---------------------------------------
  // Both seeded with placeholders here; operator rotates real values
  // post-deploy (see runbook above). RemovalPolicy.RETAIN keeps the secrets
  // alive across `cdk destroy` so re-deploy doesn't force a re-seed.
  const bearerSecret = new Secret(scope, 'LinkedInWebhookBearer', {
    secretName: 'kos/linkedin-webhook-bearer',
    description:
      'Bearer token for Chrome extension → linkedin-webhook (CAP-05).',
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const hmacSecret = new Secret(scope, 'LinkedInWebhookHmac', {
    secretName: 'kos/linkedin-webhook-hmac',
    description:
      'HMAC-SHA256 shared secret for Chrome extension → linkedin-webhook (CAP-05).',
    removalPolicy: RemovalPolicy.RETAIN,
  });

  // --- Lambda --------------------------------------------------------------
  // Outside the VPC per D-05 — Lambda only talks to Secrets Manager + EventBridge.
  // 10s timeout is plenty: handler does Bearer/HMAC check + Zod parse + PutEvents.
  const fn = new KosLambda(scope, 'LinkedInWebhook', {
    entry: svcEntry('linkedin-webhook'),
    timeout: Duration.seconds(10),
    memory: 256,
    environment: {
      BEARER_SECRET_ARN: bearerSecret.secretArn,
      HMAC_SECRET_ARN: hmacSecret.secretArn,
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
      ...(props.langfusePublicKeySecret
        ? {
            LANGFUSE_PUBLIC_KEY_SECRET_ARN:
              props.langfusePublicKeySecret.secretArn,
          }
        : {}),
      ...(props.langfuseSecretKeySecret
        ? {
            LANGFUSE_SECRET_KEY_SECRET_ARN:
              props.langfuseSecretKeySecret.secretArn,
          }
        : {}),
    },
  });

  // --- IAM grants ----------------------------------------------------------
  bearerSecret.grantRead(fn);
  hmacSecret.grantRead(fn);
  props.captureBus.grantPutEventsTo(fn);
  props.sentryDsnSecret?.grantRead(fn);
  props.langfusePublicKeySecret?.grantRead(fn);
  props.langfuseSecretKeySecret?.grantRead(fn);

  // --- Function URL --------------------------------------------------------
  // authType=NONE per the Plan 05-02 D-X "Bearer+HMAC is the auth" decision.
  // Same posture as iOS webhook (D-02) — Lambda IAM auth would force the
  // Chrome extension to sign SigV4, which it can't.
  const url = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
  });

  new CfnOutput(scope, 'LinkedInWebhookUrl', {
    value: url.url,
    exportName: 'KosLinkedInWebhookUrl',
    description:
      'LinkedIn DM webhook Function URL (Plan 05-02 / CAP-05). Paste into Chrome extension options.',
  });

  return {
    webhookFunction: fn,
    webhookUrl: url.url,
    bearerSecret,
    hmacSecret,
  };
}
