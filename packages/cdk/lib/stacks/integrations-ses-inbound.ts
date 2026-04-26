/**
 * SES inbound pipeline wiring helper (Phase 4 Plan 04-02 / CAP-03).
 *
 * Surface: `wireSesInbound` — installs the ses-inbound Lambda + IAM grants in
 * the eu-north-1 IntegrationsStack. The S3 bucket itself + the SES receiving
 * rule + the MX record + domain verification all live in eu-west-1 and are
 * provisioned out-of-band per
 * `.planning/phases/04-email-pipeline-ios-capture/04-SES-OPERATOR-RUNBOOK.md`.
 *
 * Why split the responsibility:
 *   - SES inbound only operates in eu-west-1 in our region set (D-13). CDK
 *     stacks are pinned to a single region via `env.region`; modelling the
 *     bucket in the same stack as the Lambda would either force the whole
 *     IntegrationsStack to eu-west-1 (breaking every other resource) or
 *     require a second stack with cross-stack refs. Both are heavier than
 *     this Wave 1 needs.
 *   - The operator runbook documents the exact CLI commands to create the
 *     bucket + rule. Those resources are stable (no plan-driven churn) so
 *     manual provisioning is acceptable here. Phase 7+ may migrate to a
 *     dedicated `KosEmailPipelineEuWest1Stack` (deferred-items.md).
 *
 * The Lambda's IAM grants encode the cross-region read scope:
 *   - s3:GetObject on the bucket's `incoming/` prefix
 *     (account-wildcard pattern `kos-ses-inbound-euw1-...` so the policy
 *     survives the operator's eventual account migration).
 *   - events:PutEvents on the kos.capture bus (D-04).
 *   - lambda:InvokeFunction granted to ses.amazonaws.com with
 *     SourceAccount-conditioned permission so only THIS account's SES rule
 *     can invoke the Lambda (T-04-SES-02 mitigation).
 *
 * What's intentionally absent:
 *   - rds-db:connect (this Lambda does NOT touch RDS — D-05 says the
 *     ses-inbound path runs outside the VPC).
 *   - bedrock:* (no LLM call here — classification is downstream at
 *     email-triage).
 *   - ses:SendRawEmail (no outbound mail from this Lambda).
 *
 * The CDK test (`packages/cdk/test/integrations-ses-inbound.test.ts`)
 * asserts each of those absences explicitly.
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { PolicyStatement, Effect, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireSesInboundProps {
  /** kos.capture bus — only output of the ses-inbound Lambda. */
  captureBus: EventBus;
  /**
   * Single-user UUID Kevin operates as (KEVIN_OWNER_ID). Surfaces in the
   * dead-letter row written by `withTimeoutAndRetry` on EventBridge failure.
   */
  kevinOwnerId: string;
  /**
   * Operator-created bucket name. Defaults to `kos-ses-inbound-euw1` so the
   * Lambda's env var has a sensible value at synth time. The IAM policy
   * uses an account-wildcard pattern so the Lambda still works after the
   * operator appends a per-account suffix (e.g. `-123456789012`).
   */
  sesInboundBucketName?: string;
  /**
   * D-28 instrumentation secrets. Optional so existing test fixtures synth
   * without supplying them; production deploy passes all three.
   */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface SesInboundWiring {
  sesInboundFunction: KosLambda;
}

/**
 * Provision the ses-inbound Lambda + IAM in the host stack (eu-north-1).
 *
 * Memory: 512 MB — mailparser materialises the full MIME tree in memory;
 * 512 MB is comfortable headroom for typical 1-2 MB forwarded emails and
 * the very rare 10 MB attachment-laden message.
 *
 * Timeout: 30 s — cross-region S3 GetObject + mailparser + EventBridge emit
 * is sub-2-second in the happy path; 30 s tolerates Cohere throttling /
 * cross-region latency spikes without bouncing back to SES retry.
 */
export function wireSesInbound(
  scope: Construct,
  props: WireSesInboundProps,
): SesInboundWiring {
  const stack = Stack.of(scope);
  const bucketName = props.sesInboundBucketName ?? 'kos-ses-inbound-euw1';

  const fn = new KosLambda(scope, 'SesInbound', {
    entry: svcEntry('ses-inbound'),
    timeout: Duration.seconds(30),
    memory: 512,
    // NOT in VPC — D-05: ses-inbound is an external-AWS-API consumer only
    // (S3 GetObject + EventBridge PutEvents). VPCE bypass is unnecessary
    // because the Lambda never reaches RDS.
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      SES_INBOUND_BUCKET_NAME: bucketName,
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

  // Cross-region S3 read on `kos-ses-inbound-euw1-*/incoming/*`. Account-
  // wildcard segment so the policy does not have to be re-deployed if the
  // operator chooses a different per-account suffix.
  fn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${bucketName}-*/incoming/*`],
    }),
  );

  // D-04: only PutEvents to the capture bus. No other side-effect grants.
  props.captureBus.grantPutEventsTo(fn);

  // Allow the SES service principal IN THIS ACCOUNT to invoke the Lambda
  // (T-04-SES-02 mitigation). The receiving rule's LambdaAction targets
  // this function ARN; the SourceAccount condition prevents a confused-
  // deputy from another account triggering the Lambda via SES.
  fn.addPermission('AllowSesInvoke', {
    principal: new ServicePrincipal('ses.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceAccount: stack.account,
  });

  // Secrets grants (only if seeded — D-28 tracing degrades gracefully).
  props.sentryDsnSecret?.grantRead(fn);
  props.langfusePublicKeySecret?.grantRead(fn);
  props.langfuseSecretKeySecret?.grantRead(fn);

  return { sesInboundFunction: fn };
}
