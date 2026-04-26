/**
 * Baileys sidecar wiring helper for IntegrationsStack (Phase 5 / Plan 05-05 — CAP-06).
 *
 * Mirrors `integrations-linkedin-webhook.ts` shape, with two important
 * differences:
 *   - Auth header is `X-BAILEYS-Secret` (single shared bearer-like secret)
 *     rather than Bearer + HMAC. Justification: this Lambda is invoked by
 *     a private Fargate task on the same VPC (when Plan 05-04 lands) — the
 *     header check is a defence-in-depth gate, not the only auth surface.
 *     Constant-time compare via timingSafeEqual.
 *   - The Lambda has S3 PutObject scoped to the `audio/*` prefix so voice
 *     notes flow through the existing Phase-2 transcribe-starter pipeline
 *     unchanged.
 *
 * Helper provisions:
 *   - One Secrets Manager entry  : `kos/baileys-webhook-secret` (RETAIN)
 *   - One KosLambda              : nodejs22.x ARM64 outside the VPC (D-05)
 *   - One Lambda Function URL    : authType=NONE (header IS the auth)
 *   - IAM grants                 : SecretsManager Read,
 *                                  S3 PutObject on audio/*,
 *                                  EventBridge PutEvents on captureBus
 *
 * NO bedrock:* / ses:* / dynamodb:* / rds:* — verified by the negative
 * synth assertions in `integrations-baileys-sidecar.test.ts`.
 *
 * Operator runbook (post-deploy, before flipping enableBaileysFargate=true):
 *   1. `aws secretsmanager put-secret-value \
 *        --secret-id kos/baileys-webhook-secret \
 *        --secret-string "$(openssl rand -hex 32)"`
 *   2. Read the Function URL from CFN outputs (`KosBaileysSidecarUrl`).
 *   3. Plan 05-04's Fargate container reads the URL + secret and POSTs
 *      every observed `messages.upsert` envelope here.
 */
import { Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
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

export interface WireBaileysSidecarProps {
  /** EventBridge `kos.capture` bus — Lambda emits `capture.received` events. */
  captureBus: EventBus;
  /** Shared blobs bucket — Lambda PUTs `audio/{YYYY}/{MM}/{ULID}.ogg`. */
  blobsBucket: IBucket;
  /**
   * Optional override for the upstream Baileys Fargate container's media
   * endpoint base URL. Until Plan 05-04 lands the actual service-discovery
   * name the helper uses a placeholder so the env var is always populated
   * (the Lambda treats a missing env as "drop voice messages" — see
   * handler.ts). Production deploy supplies the real Fargate DNS once
   * Plan 05-04 ships.
   */
  baileysMediaBaseUrl?: string;
  /** Optional Sentry DSN secret — wired into the Lambda env if provided. */
  sentryDsnSecret?: ISecret;
  /** Optional Langfuse public-key secret. */
  langfusePublicKeySecret?: ISecret;
  /** Optional Langfuse secret-key secret. */
  langfuseSecretKeySecret?: ISecret;
}

export interface BaileysSidecarWiring {
  webhookFunction: KosLambda;
  webhookUrl: string;
  /**
   * Provisioned `kos/baileys-webhook-secret` Secret. Plan 05-04's Fargate
   * task definition reads this secret via `Secret.fromSecretsManager` to
   * pass the same value back as the X-BAILEYS-Secret header on every POST.
   */
  webhookSecret: Secret;
}

export function wireBaileysSidecar(
  scope: Construct,
  props: WireBaileysSidecarProps,
): BaileysSidecarWiring {
  // --- Secrets Manager: shared bearer-like secret -------------------------
  // Seeded with PLACEHOLDER; operator rotates real value post-deploy via
  // `aws secretsmanager put-secret-value` (see runbook). RemovalPolicy.RETAIN
  // keeps it alive across `cdk destroy` so re-deploy doesn't force a
  // re-pairing with the Fargate container's env.
  const webhookSecret = new Secret(scope, 'BaileysWebhookSecret', {
    secretName: 'kos/baileys-webhook-secret',
    description:
      'Shared X-BAILEYS-Secret header value between Baileys Fargate container and baileys-sidecar Lambda (CAP-06).',
    removalPolicy: RemovalPolicy.RETAIN,
  });

  // --- Lambda --------------------------------------------------------------
  // Outside the VPC per D-05 — Lambda only talks to Secrets Manager + S3 +
  // EventBridge + Fargate /media (HTTP fetch over the Function URL's
  // outbound internet path; Plan 05-04 will narrow this to a private
  // service-discovery name when the Fargate container ships).
  // 30s timeout: media fetch + S3 PutObject can run a few seconds for
  // 1-MB voice notes; matches the rest of the capture-ingress fleet.
  const fn = new KosLambda(scope, 'BaileysSidecar', {
    entry: svcEntry('baileys-sidecar'),
    timeout: Duration.seconds(30),
    memory: 512,
    environment: {
      BAILEYS_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      BLOBS_BUCKET: props.blobsBucket.bucketName,
      BAILEYS_MEDIA_BASE_URL:
        props.baileysMediaBaseUrl ??
        'http://baileys.kos-internal.local:3025/media',
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
  webhookSecret.grantRead(fn);
  // T-05-05-02: scope S3 PUT to the `audio/*` prefix only (matches the
  // VPCe-bypass row in DataStack; transcribe-starter's S3 trigger fires on
  // any audio/* PutObject so no further wiring needed).
  props.blobsBucket.grantPut(fn, 'audio/*');
  props.captureBus.grantPutEventsTo(fn);
  props.sentryDsnSecret?.grantRead(fn);
  props.langfusePublicKeySecret?.grantRead(fn);
  props.langfuseSecretKeySecret?.grantRead(fn);

  // --- Function URL --------------------------------------------------------
  // authType=NONE per the Plan 05-05 D-X "X-BAILEYS-Secret IS the auth"
  // decision. Same posture as iOS / Chrome / LinkedIn webhooks (D-02).
  const url = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
  });

  new CfnOutput(scope, 'BaileysSidecarUrl', {
    value: url.url,
    exportName: 'KosBaileysSidecarUrl',
    description:
      'Baileys sidecar Lambda Function URL (Plan 05-05 / CAP-06). Plan 05-04 wires this into the Fargate container env as BAILEYS_WEBHOOK_URL.',
  });

  return { webhookFunction: fn, webhookUrl: url.url, webhookSecret };
}
