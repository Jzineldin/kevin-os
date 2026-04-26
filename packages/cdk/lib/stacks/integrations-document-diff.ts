/**
 * Phase 8 MEM-05 document-diff wiring helper (Plan 08-05 Task 2).
 *
 * Deploys:
 *   - services/document-diff   Lambda  (Bedrock Haiku 4.5 EU + RDS Proxy + S3 read)
 *   - EventBridge rule on kos.output / email.sent → document-diff
 *
 * IAM scope (CDK tests assert):
 *   - bedrock:InvokeModel + InvokeModelWithResponseStream on Haiku 4.5 EU
 *     profile ONLY (NOT Sonnet, NOT any other model). Document-diff has
 *     a hard model pin in src/diff-summary.ts and the IAM grant matches.
 *   - s3:GetObject on the kos-blobs bucket (attachment fetches).
 *   - rds-db:connect as `kos_document_diff` user only — read+insert on
 *     document_versions, no UPDATE / DELETE / other tables.
 *   - events:PutEvents on kos.output (for document.version.created emit).
 *
 * EXPLICITLY NO grants (CDK Test 6 enforces via grep):
 *   - postiz:* — drafting + diff tracking never publishes
 *   - ses:*    — diff tracking never sends mail
 *   - notion writes — diff tracking never mutates Notion
 *
 * Trust boundary alignment (Plan 08-05 §threat_model):
 *   - T-08-DIFF-02 (S3 tampering): document-diff has READ-only S3.
 *   - T-08-DIFF-04 (prompt injection in document text): no publish IAM,
 *     so a successful injection cannot exfiltrate or auto-act.
 *   - T-08-DIFF-06 (timeline leak): query-side filter is in
 *     dashboard-api; CDK only enforces the structural Lambda IAM.
 *
 * Reference:
 *   .planning/phases/08-outbound-content-calendar/08-05-PLAN.md
 *   packages/db/drizzle/0020_phase_8_content_mutations_calendar_documents.sql
 *   services/document-diff/src/handler.ts
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack } from 'aws-cdk-lib';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { type EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireDocumentDiffProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** kos-blobs S3 bucket — document-diff reads attachments from here. */
  blobsBucket: IBucket;
  /** kos.output bus — triggers email.sent rule + receives version.created. */
  outputBus: EventBus;
  /** Owner UUID — KEVIN_OWNER_ID env var. */
  kevinOwnerId: string;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface DocumentDiffWiring {
  documentDiff: KosLambda;
  emailSentRule: Rule;
}

export function wireDocumentDiff(
  scope: Construct,
  props: WireDocumentDiffProps,
): DocumentDiffWiring {
  const stack = Stack.of(scope);
  const RDS_USER = 'kos_document_diff';

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // ---------------------------------------------------------------------
  // document-diff Lambda
  // ---------------------------------------------------------------------
  const documentDiff = new KosLambda(scope, 'DocumentDiff', {
    entry: svcEntry('document-diff'),
    timeout: Duration.minutes(2),
    memory: 1024,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: RDS_USER,
      RDS_DATABASE: 'kos',
      BLOBS_BUCKET: props.blobsBucket.bucketName,
      OUTPUT_BUS_NAME: props.outputBus.eventBusName,
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

  // ---------------------------------------------------------------------
  // IAM grants
  // ---------------------------------------------------------------------

  // Bedrock Haiku 4.5 EU — pinned model + EU cross-region inference profile.
  // Sonnet + other foundation models are NOT in the resource list, so a
  // misconfigured src/diff-summary.ts pointing at Sonnet would 403.
  documentDiff.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-haiku-4-5*',
      ],
    }),
  );

  // RDS Proxy IAM auth as kos_document_diff (read+insert on document_versions
  // ONLY — operator runbook seeds the Postgres role with exactly that grant).
  documentDiff.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${RDS_USER}`,
      ],
    }),
  );

  // S3 read on the kos-blobs bucket — attachment fetch.
  props.blobsBucket.grantRead(documentDiff);

  // EventBridge: PutEvents on the output bus (document.version.created emit).
  props.outputBus.grantPutEventsTo(documentDiff);

  // Observability secrets.
  if (props.sentryDsnSecret) props.sentryDsnSecret.grantRead(documentDiff);
  if (props.langfusePublicKeySecret)
    props.langfusePublicKeySecret.grantRead(documentDiff);
  if (props.langfuseSecretKeySecret)
    props.langfuseSecretKeySecret.grantRead(documentDiff);

  // EXPLICITLY NO postiz:* / ses:* / notion writes — drafting+diff never publishes.

  // ---------------------------------------------------------------------
  // EventBridge rule: kos.output / email.sent → document-diff
  // ---------------------------------------------------------------------
  const emailSentRule = new Rule(scope, 'EmailSentForDiffRule', {
    eventBus: props.outputBus,
    eventPattern: {
      source: ['kos.output'],
      detailType: ['email.sent'],
    },
    targets: [
      new LambdaTarget(documentDiff, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  return { documentDiff, emailSentRule };
}
