/**
 * Phase 4 email-pipeline wiring helper.
 *
 * Unified helper that composes BOTH Approve-gate halves so Plans 04-04
 * (email-triage) and 04-05 (email-sender) accrete on a single helper:
 *
 *   wireEmailAgents(scope, props)
 *     ├── EmailTriageAgent   KosLambda  (AGT-05; classify Haiku 4.5 + draft Sonnet 4.6)
 *     ├── EmailSender        KosLambda  (Plan 04-05; SES SendRawEmail; NO Bedrock)
 *     ├── EmailTriageDlq     SQS Queue  (Phase 7 alarms target this independently)
 *     ├── EmailTriageCaptureRule  Rule  (kos.capture / capture.received[email_*])
 *     ├── EmailTriageScanRule     Rule  (kos.system / scan_emails_now)
 *     └── EmailApprovedRule       Rule  (kos.output / email.approved → sender)
 *
 * Hard structural invariants asserted by CDK tests
 * (Phase 4 §threat_model T-04-TRIAGE-02 / T-04-SENDER-01/02):
 *   - email-triage: NO `ses:*` action ever appears in role policy.
 *   - email-sender: NO `bedrock:*` action ever appears in role policy.
 *   - email-sender: `ses:SendRawEmail` scoped to tale-forge.app SES
 *     identity ONLY (no `ses:*`, no other identities).
 *   - email-sender: `rds-db:connect` as `kos_email_sender` ONLY
 *     (NOT kos_admin / kos_agent_writer / kos_email_triage).
 *   - email-sender: `events:PutEvents` on kos.output (for `email.sent`).
 *   - EmailApprovedRule fires on source=['kos.output'] +
 *     detailType=['email.approved'].
 *
 * Together these make the Approve gate structurally non-bypassable.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireEmailAgentsProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** `kos.capture` — email-triage rule listens on capture.received. */
  captureBus: EventBus;
  /** `kos.system` — email-triage scan rule listens on scan_emails_now. */
  systemBus: EventBus;
  /** `kos.output` — email-sender's trigger source AND email-triage's emit target. */
  outputBus: EventBus;
  /** Owner UUID for KEVIN_OWNER_ID env var. */
  kevinOwnerId: string;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  notionTokenSecret?: ISecret;
  azureSearchAdminSecret?: ISecret;
  /** Override; defaults to 'kos-memory-v2'. */
  azureSearchIndexName?: string;
  /** SES verified domain identity name (e.g. 'tale-forge.app'). */
  sesIdentityDomain?: string;
}

export interface EmailAgentsWiring {
  emailTriageFn: KosLambda;
  emailSenderFn: KosLambda;
  emailTriageDlq: Queue;
  emailTriageCaptureRule: Rule;
  emailTriageScanRule: Rule;
  emailApprovedRule: Rule;
}

export function wireEmailAgents(
  scope: Construct,
  p: WireEmailAgentsProps,
): EmailAgentsWiring {
  const stack = Stack.of(scope);
  const sesDomain = p.sesIdentityDomain ?? 'tale-forge.app';
  const TRIAGE_RDS_USER = 'kos_email_triage';
  const SENDER_RDS_USER = 'kos_email_sender';

  const vpcConfig = {
    vpc: p.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [p.rdsSecurityGroup],
  };

  // -----------------------------------------------------------------------
  // email-triage (Plan 04-04 AGT-05)
  // -----------------------------------------------------------------------

  const emailTriageDlq = new Queue(scope, 'EmailTriageDlq', {
    queueName: 'kos-email-triage-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });

  const emailTriageFn = new KosLambda(scope, 'EmailTriageAgent', {
    entry: svcEntry('email-triage'),
    timeout: Duration.minutes(5),
    memory: 1024,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: TRIAGE_RDS_USER,
      RDS_DATABASE: 'kos',
      OUTPUT_BUS_NAME: p.outputBus.eventBusName,
      CLAUDE_CODE_USE_BEDROCK: '1',
      ...(p.sentryDsnSecret ? { SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn } : {}),
      ...(p.langfusePublicKeySecret
        ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicKeySecret.secretArn }
        : {}),
      ...(p.langfuseSecretKeySecret
        ? { LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretKeySecret.secretArn }
        : {}),
      ...(p.notionTokenSecret
        ? { NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn }
        : {}),
      ...(p.azureSearchAdminSecret
        ? {
            AZURE_SEARCH_ADMIN_SECRET_ARN: p.azureSearchAdminSecret.secretArn,
            AZURE_SEARCH_INDEX_NAME: p.azureSearchIndexName ?? 'kos-memory-v2',
          }
        : {}),
    },
  });

  // Bedrock InvokeModel scoped to Haiku 4.5 + Sonnet 4.6 EU profiles only.
  // STRUCTURAL Approve gate: NO ses:* on this role (CDK test asserts).
  emailTriageFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-haiku-4-5*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*',
      ],
    }),
  );

  emailTriageFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${TRIAGE_RDS_USER}`,
      ],
    }),
  );

  p.outputBus.grantPutEventsTo(emailTriageFn);

  if (p.sentryDsnSecret) p.sentryDsnSecret.grantRead(emailTriageFn);
  if (p.langfusePublicKeySecret) p.langfusePublicKeySecret.grantRead(emailTriageFn);
  if (p.langfuseSecretKeySecret) p.langfuseSecretKeySecret.grantRead(emailTriageFn);
  if (p.notionTokenSecret) p.notionTokenSecret.grantRead(emailTriageFn);
  if (p.azureSearchAdminSecret) {
    p.azureSearchAdminSecret.grantRead(emailTriageFn);
    emailTriageFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*:*:inference-profile/eu.cohere.embed-v4*',
          'arn:aws:bedrock:*::foundation-model/cohere.embed-v4*',
        ],
      }),
    );
  }

  const emailTriageCaptureRule = new Rule(scope, 'EmailTriageCaptureRule', {
    eventBus: p.captureBus,
    eventPattern: {
      source: ['kos.capture'],
      detailType: ['capture.received'],
      detail: { kind: ['email_inbox', 'email_forward'] },
    },
    targets: [
      new LambdaTarget(emailTriageFn, {
        deadLetterQueue: emailTriageDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  const emailTriageScanRule = new Rule(scope, 'EmailTriageScanRule', {
    eventBus: p.systemBus,
    eventPattern: {
      source: ['kos.system'],
      detailType: ['scan_emails_now'],
    },
    targets: [
      new LambdaTarget(emailTriageFn, {
        deadLetterQueue: emailTriageDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  // -----------------------------------------------------------------------
  // email-sender (Plan 04-05) — STRUCTURAL Approve gate
  // -----------------------------------------------------------------------
  //
  // 512MB / 30s — SES SendRawEmail + Postgres FOR UPDATE lock + a single
  // PutEvents takes <2s; 30s leaves headroom for IAM token mint + cold start.
  // NO bedrock perms — structural separation from email-triage (CDK test
  // integrations-email-sender.test.ts asserts).
  const emailSenderFn = new KosLambda(scope, 'EmailSender', {
    entry: svcEntry('email-sender'),
    timeout: Duration.seconds(30),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: SENDER_RDS_USER,
      RDS_DATABASE: 'kos',
      ...(p.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn }
        : {}),
      ...(p.langfusePublicKeySecret
        ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicKeySecret.secretArn }
        : {}),
      ...(p.langfuseSecretKeySecret
        ? { LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretKeySecret.secretArn }
        : {}),
    },
  });

  emailSenderFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:SendRawEmail'],
      resources: [
        `arn:aws:ses:${stack.region}:${stack.account}:identity/${sesDomain}`,
      ],
    }),
  );

  emailSenderFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${SENDER_RDS_USER}`,
      ],
    }),
  );

  p.outputBus.grantPutEventsTo(emailSenderFn);

  if (p.sentryDsnSecret) p.sentryDsnSecret.grantRead(emailSenderFn);
  if (p.langfusePublicKeySecret) p.langfusePublicKeySecret.grantRead(emailSenderFn);
  if (p.langfuseSecretKeySecret) p.langfuseSecretKeySecret.grantRead(emailSenderFn);

  // EXPLICITLY NO bedrock:* — structural Approve-gate guarantee.

  const emailApprovedRule = new Rule(scope, 'EmailApprovedRule', {
    eventBus: p.outputBus,
    eventPattern: {
      source: ['kos.output'],
      detailType: ['email.approved'],
    },
    targets: [
      new LambdaTarget(emailSenderFn, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  return {
    emailTriageFn,
    emailSenderFn,
    emailTriageDlq,
    emailTriageCaptureRule,
    emailTriageScanRule,
    emailApprovedRule,
  };
}
