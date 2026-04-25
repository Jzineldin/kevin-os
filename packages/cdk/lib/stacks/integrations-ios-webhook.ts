/**
 * iOS Shortcut webhook wiring helper for IntegrationsStack (Phase 4 / Plan 04-01).
 *
 * Mirrors `integrations-telegram.ts` shape:
 *   - KosLambda (outside the VPC per D-05; HMAC + replay are the auth boundary)
 *   - Lambda Function URL (authType=NONE per D-02; HMAC is the only gate)
 *   - DynamoDB replay cache `kos-ios-webhook-replay` (TTL on `expires_at`)
 *   - Secrets Manager entry `kos/ios-shortcut-webhook-secret`
 *   - IAM grants: SecretsManager Read, DDB PutItem, S3 PutObject on `audio/*`,
 *     EventBridge PutEvents on the capture bus
 *
 * NO bedrock:* / ses:* / dynamodb:Scan grants — verified via the
 * `integrations-ios-webhook.test.ts` synth assertions.
 *
 * Operator runbook (post-deploy, before iOS Shortcut goes live):
 *   1. `aws secretsmanager put-secret-value --secret-id kos/ios-shortcut-webhook-secret --secret-string "$(openssl rand -hex 32)"`
 *   2. Read the Function URL from CFN outputs (`KosIosWebhookUrl`)
 *   3. Paste both into the iOS Shortcut "Get contents of URL" + "Get keychain item"
 *      actions and configure the body shape per Plan 04-01 §interfaces.
 */
import { Duration, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
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

export interface WireIosWebhookProps {
  /** EventBridge `kos.capture` bus — Lambda emits `capture.received` events. */
  captureBus: EventBus;
  /** Shared blobs bucket — Lambda PUTs `audio/<ulid>.m4a` via VPCe-bypass. */
  blobsBucket: IBucket;
  /**
   * The pre-created `kos/ios-shortcut-webhook-secret` Secrets Manager entry.
   * DataStack creates the placeholder; the operator seeds the real value
   * post-deploy via `scripts/seed-secrets.sh`.
   */
  iosShortcutWebhookSecret: ISecret;
  /** Optional Sentry DSN secret — wired into the Lambda env if provided. */
  sentryDsnSecret?: ISecret;
}

export interface IosWebhookWiring {
  webhookFunction: KosLambda;
  webhookUrl: string;
  replayTable: Table;
}

export function wireIosWebhook(
  scope: Construct,
  props: WireIosWebhookProps,
): IosWebhookWiring {
  // --- DynamoDB replay cache ----------------------------------------------
  // Single-region eu-north-1, partition key `signature` (the v1 hex), TTL on
  // `expires_at` (now+600s). PAY_PER_REQUEST is cheaper than provisioned for
  // single-user volume (<100 writes/day).
  const replayTable = new Table(scope, 'IosWebhookReplay', {
    tableName: 'kos-ios-webhook-replay',
    partitionKey: { name: 'signature', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    timeToLiveAttribute: 'expires_at',
  });

  // --- Lambda --------------------------------------------------------------
  // Outside the VPC per D-05 (no RDS reach needed; talks only to S3, DDB,
  // EventBridge, Secrets Manager — all VPCe-friendly via service endpoints).
  // 15s timeout matches the iOS Shortcut "Wait for response" UX expectation.
  const fn = new KosLambda(scope, 'IosWebhook', {
    entry: svcEntry('ios-webhook'),
    timeout: Duration.seconds(15),
    memory: 512,
    environment: {
      WEBHOOK_SECRET_ARN: props.iosShortcutWebhookSecret.secretArn,
      REPLAY_TABLE_NAME: replayTable.tableName,
      BLOBS_BUCKET: props.blobsBucket.bucketName,
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
    },
  });

  // --- IAM grants ----------------------------------------------------------
  props.iosShortcutWebhookSecret.grantRead(fn);
  replayTable.grantWriteData(fn);
  // T-04-IOS-03: scope S3 PUT to the `audio/*` prefix only (matches the
  // VPCe-bypass row in DataStack; transcribe-starter's S3 trigger fires on
  // any audio/* PutObject so no further wiring needed).
  props.blobsBucket.grantPut(fn, 'audio/*');
  props.captureBus.grantPutEventsTo(fn);
  props.sentryDsnSecret?.grantRead(fn);

  // --- Function URL --------------------------------------------------------
  // authType=NONE per D-02. HMAC + DDB replay-cache IS the auth boundary;
  // Lambda IAM auth would require iOS Shortcut to sign SigV4 (it can't).
  const url = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.NONE,
    invokeMode: InvokeMode.BUFFERED,
  });

  new CfnOutput(scope, 'IosWebhookUrl', {
    value: url.url,
    exportName: 'KosIosWebhookUrl',
    description: 'iOS Action Button Shortcut webhook (CAP-02)',
  });

  return { webhookFunction: fn, webhookUrl: url.url, replayTable };
}
