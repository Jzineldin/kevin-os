/**
 * Phase 8 AGT-08 imperative-verb mutation pipeline wiring helper (Plan 08-04).
 *
 * Deploys two Lambdas + two EventBridge rules + tightly scoped IAM:
 *
 *   - mutation-proposer  Lambda  (Bedrock Haiku 4.5 + Sonnet 4.6 EU profiles)
 *   - mutation-executor  Lambda  (UPDATE-only DB writes; Notion task archive)
 *   - MutationProposerRule       (kos.capture / capture.received[text|voice_transcribed])
 *   - MutationExecutorRule       (kos.output  / pending_mutation.approved)
 *
 * STRUCTURAL invariants asserted by the CDK test (Plan 08-04 §threat_model):
 *   - mutation-proposer: bedrock:InvokeModel scoped to Haiku + Sonnet only;
 *                        rds-db:connect as kos_mutation_proposer ONLY;
 *                        events:PutEvents on agentBus.
 *                        NO ses:*, NO postiz:*, NO Notion writes, NO DELETE.
 *   - mutation-executor: rds-db:connect as kos_mutation_executor ONLY;
 *                        events:PutEvents on outputBus;
 *                        secrets:GetSecretValue on the Notion token secret.
 *                        NO bedrock:*, NO ses:*, NO postiz:*,
 *                        NO Google Calendar scope, NO DELETE grants.
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
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

const PROPOSER_RDS_USER = 'kos_mutation_proposer';
const EXECUTOR_RDS_USER = 'kos_mutation_executor';

export interface WireMutationPipelineProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** kos.capture — proposer's source bus. */
  captureBus: EventBus;
  /** kos.agent — proposer emits pending_mutation.proposed here. */
  agentBus: EventBus;
  /** kos.output — executor's source bus + emit target. */
  outputBus: EventBus;
  kevinOwnerId: string;
  notionTokenSecret: ISecret;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface MutationPipelineWiring {
  proposerFn: KosLambda;
  executorFn: KosLambda;
  proposerRule: Rule;
  executorRule: Rule;
}

export function wireMutationPipeline(
  scope: Construct,
  p: WireMutationPipelineProps,
): MutationPipelineWiring {
  const stack = Stack.of(scope);

  const vpcConfig = {
    vpc: p.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [p.rdsSecurityGroup],
  };

  const sharedTracingEnv = {
    ...(p.sentryDsnSecret ? { SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn } : {}),
    ...(p.langfusePublicKeySecret
      ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: p.langfusePublicKeySecret.secretArn }
      : {}),
    ...(p.langfuseSecretKeySecret
      ? { LANGFUSE_SECRET_KEY_SECRET_ARN: p.langfuseSecretKeySecret.secretArn }
      : {}),
  };

  // ---------------------------------------------------------------------
  // mutation-proposer
  // ---------------------------------------------------------------------

  const proposerFn = new KosLambda(scope, 'MutationProposer', {
    entry: svcEntry('mutation-proposer'),
    timeout: Duration.minutes(2),
    memory: 1024,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: PROPOSER_RDS_USER,
      RDS_DATABASE: 'kos',
      AGENT_BUS_NAME: p.agentBus.eventBusName,
      CLAUDE_CODE_USE_BEDROCK: '1',
      ...sharedTracingEnv,
    },
  });

  // Bedrock InvokeModel — Haiku 4.5 + Sonnet 4.6 EU CRIS profiles only.
  proposerFn.addToRolePolicy(
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

  proposerFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${PROPOSER_RDS_USER}`,
      ],
    }),
  );

  p.agentBus.grantPutEventsTo(proposerFn);

  if (p.sentryDsnSecret) p.sentryDsnSecret.grantRead(proposerFn);
  if (p.langfusePublicKeySecret) p.langfusePublicKeySecret.grantRead(proposerFn);
  if (p.langfuseSecretKeySecret) p.langfuseSecretKeySecret.grantRead(proposerFn);

  // EXPLICITLY NO: ses:*, postiz:*, Notion writes (proposer cannot publish).

  // ---------------------------------------------------------------------
  // mutation-executor
  // ---------------------------------------------------------------------

  const executorFn = new KosLambda(scope, 'MutationExecutor', {
    entry: svcEntry('mutation-executor'),
    timeout: Duration.seconds(30),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: p.kevinOwnerId,
      RDS_PROXY_ENDPOINT: p.rdsProxyEndpoint,
      RDS_IAM_USER: EXECUTOR_RDS_USER,
      RDS_DATABASE: 'kos',
      OUTPUT_BUS_NAME: p.outputBus.eventBusName,
      NOTION_TOKEN_SECRET_ARN: p.notionTokenSecret.secretArn,
      ...sharedTracingEnv,
    },
  });

  executorFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${p.rdsProxyDbiResourceId}/${EXECUTOR_RDS_USER}`,
      ],
    }),
  );

  p.outputBus.grantPutEventsTo(executorFn);
  p.notionTokenSecret.grantRead(executorFn);

  if (p.sentryDsnSecret) p.sentryDsnSecret.grantRead(executorFn);
  if (p.langfusePublicKeySecret) p.langfusePublicKeySecret.grantRead(executorFn);
  if (p.langfuseSecretKeySecret) p.langfuseSecretKeySecret.grantRead(executorFn);

  // EXPLICITLY NO: bedrock:*, ses:*, postiz:*, Google Calendar scope.
  // DB role kos_mutation_executor MUST be created (operator SQL) with
  // UPDATE-only grants on calendar_events_cache / inbox_index /
  // content_drafts / email_drafts / pending_mutations — no DELETE.

  // ---------------------------------------------------------------------
  // EventBridge rules
  // ---------------------------------------------------------------------

  const proposerRule = new Rule(scope, 'MutationProposerRule', {
    eventBus: p.captureBus,
    eventPattern: {
      source: ['kos.capture'],
      detailType: ['capture.received'],
      detail: { kind: ['text', 'voice_transcribed', 'telegram-text', 'dashboard-text'] },
    },
    targets: [
      new LambdaTarget(proposerFn, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  const executorRule = new Rule(scope, 'MutationExecutorRule', {
    eventBus: p.outputBus,
    eventPattern: {
      source: ['kos.output'],
      detailType: ['pending_mutation.approved'],
    },
    targets: [
      new LambdaTarget(executorFn, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  return { proposerFn, executorFn, proposerRule, executorRule };
}
