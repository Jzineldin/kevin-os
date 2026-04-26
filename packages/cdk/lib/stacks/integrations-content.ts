/**
 * Phase 8 AGT-07 content-writer wiring helper (Plan 08-02 Task 3).
 *
 * Deploys:
 *   - services/content-writer            orchestrator Lambda  (StartExecution)
 *   - services/content-writer-platform   per-platform worker  (Sonnet 4.6)
 *   - Step Functions Standard state machine `kos-content-writer-5platform`
 *     (Map state, maxConcurrency=5)
 *   - EventBridge rule on kos.agent / content.topic_submitted → orchestrator
 *
 * IAM split (CDK tests assert):
 *   - orchestrator:    states:StartExecution, events:PutEvents (kos.agent),
 *                      rds-db:connect as kos_content_writer_orchestrator
 *                      Explicitly NO bedrock:*, postiz:*, ses:*
 *   - platform worker: bedrock:InvokeModel on Sonnet 4.6 EU CRIS profile,
 *                      rds-db:connect as kos_content_writer_platform
 *                      Explicitly NO postiz:*, ses:* — drafting NEVER publishes
 *
 * Threat model alignment (Plan 08-02 §threat_model):
 *   - T-08-CW-01 (publish elevation):  no postiz:* on either Lambda
 *   - T-08-CW-02 (forged events):      EventBridge source-restricted
 *   - T-08-CW-04 (DoS via Map):        maxConcurrency=5 + 10-min SFN timeout
 *   - T-08-CW-08 (BRAND_VOICE flip):   handled in-Lambda (brand-voice.ts);
 *                                      no infra-side enforcement here
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack } from 'aws-cdk-lib';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { type EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  StateMachine,
  StateMachineType,
  Map as SfnMap,
  LogLevel,
  DefinitionBody,
  JsonPath,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireContentWriterProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** `kos.agent` — orchestrator listens for content.topic_submitted; emits
   *  content.orchestration.started. */
  agentBus: EventBus;
  /** Owner UUID — KEVIN_OWNER_ID env var on both Lambdas. */
  kevinOwnerId: string;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface ContentWriterWiring {
  orchestrator: KosLambda;
  platformWorker: KosLambda;
  stateMachine: StateMachine;
  topicSubmittedRule: Rule;
}

export function wireContentWriter(
  scope: Construct,
  props: WireContentWriterProps,
): ContentWriterWiring {
  const stack = Stack.of(scope);
  const ORCHESTRATOR_RDS_USER = 'kos_content_writer_orchestrator';
  const PLATFORM_RDS_USER = 'kos_content_writer_platform';

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // ---------------------------------------------------------------------
  // Per-platform worker (Sonnet 4.6) — built first so the orchestrator can
  // reference its ARN in the Step Functions Map state.
  // ---------------------------------------------------------------------

  const platformWorker = new KosLambda(scope, 'ContentWriterPlatform', {
    entry: svcEntry('content-writer-platform'),
    timeout: Duration.minutes(5),
    memory: 1024,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: PLATFORM_RDS_USER,
      RDS_DATABASE: 'kos',
      CLAUDE_CODE_USE_BEDROCK: '1',
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

  platformWorker.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*',
      ],
    }),
  );

  platformWorker.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${PLATFORM_RDS_USER}`,
      ],
    }),
  );

  if (props.sentryDsnSecret) props.sentryDsnSecret.grantRead(platformWorker);
  if (props.langfusePublicKeySecret) props.langfusePublicKeySecret.grantRead(platformWorker);
  if (props.langfuseSecretKeySecret) props.langfuseSecretKeySecret.grantRead(platformWorker);

  // EXPLICITLY NO postiz:*, ses:* — drafting must never publish (T-08-CW-01).

  // ---------------------------------------------------------------------
  // Step Functions state machine — Map fan-out to platformWorker
  // ---------------------------------------------------------------------

  const draftTask = new LambdaInvoke(scope, 'DraftPlatformTask', {
    lambdaFunction: platformWorker,
    payloadResponseOnly: true,
  }).addRetry({
    errors: [
      'States.TaskFailed',
      'Lambda.TooManyRequestsException',
      'Lambda.ServiceException',
      'Lambda.AWSLambdaException',
      'Lambda.SdkClientException',
    ],
    maxAttempts: 2,
    interval: Duration.seconds(2),
    backoffRate: 2,
  });

  const mapState = new SfnMap(scope, 'DraftAllPlatforms', {
    itemsPath: JsonPath.stringAt('$.platforms'),
    maxConcurrency: 5,
    itemSelector: {
      topic_id: JsonPath.stringAt('$.topic_id'),
      capture_id: JsonPath.stringAt('$.capture_id'),
      topic_text: JsonPath.stringAt('$.topic_text'),
      'platform.$': '$$.Map.Item.Value',
    },
    resultPath: '$.drafts',
  });
  mapState.itemProcessor(draftTask);

  const stateMachine = new StateMachine(scope, 'ContentWriterStateMachine', {
    stateMachineName: 'kos-content-writer-5platform',
    stateMachineType: StateMachineType.STANDARD,
    definitionBody: DefinitionBody.fromChainable(mapState),
    timeout: Duration.minutes(10),
    logs: {
      destination: new LogGroup(scope, 'ContentWriterSfnLogs', {
        retention: RetentionDays.ONE_MONTH,
      }),
      level: LogLevel.ERROR,
    },
  });

  // ---------------------------------------------------------------------
  // Orchestrator — starts the state machine
  // ---------------------------------------------------------------------

  const orchestrator = new KosLambda(scope, 'ContentWriter', {
    entry: svcEntry('content-writer'),
    timeout: Duration.seconds(30),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: ORCHESTRATOR_RDS_USER,
      RDS_DATABASE: 'kos',
      SFN_CONTENT_WRITER_ARN: stateMachine.stateMachineArn,
      AGENT_BUS_NAME: props.agentBus.eventBusName,
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

  stateMachine.grantStartExecution(orchestrator);

  orchestrator.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${ORCHESTRATOR_RDS_USER}`,
      ],
    }),
  );

  props.agentBus.grantPutEventsTo(orchestrator);

  if (props.sentryDsnSecret) props.sentryDsnSecret.grantRead(orchestrator);
  if (props.langfusePublicKeySecret) props.langfusePublicKeySecret.grantRead(orchestrator);
  if (props.langfuseSecretKeySecret) props.langfuseSecretKeySecret.grantRead(orchestrator);

  // EXPLICITLY NO bedrock:*, postiz:*, ses:* on the orchestrator role.

  // ---------------------------------------------------------------------
  // EventBridge rule: kos.agent / content.topic_submitted → orchestrator
  // ---------------------------------------------------------------------

  const topicSubmittedRule = new Rule(scope, 'ContentTopicSubmittedRule', {
    eventBus: props.agentBus,
    eventPattern: {
      source: ['kos.agent'],
      detailType: ['content.topic_submitted'],
    },
    targets: [
      new LambdaTarget(orchestrator, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  return { orchestrator, platformWorker, stateMachine, topicSubmittedRule };
}
