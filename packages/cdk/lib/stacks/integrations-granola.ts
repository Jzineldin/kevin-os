/**
 * Granola poller + transcript-extractor wiring helper (Phase 6).
 *
 * Installs:
 *   - granola-poller Lambda (CAP-08 + AUTO-05)
 *   - transcript-extractor Lambda (AGT-06)
 *   - EventBridge Scheduler entry: every 15 min, Europe/Stockholm
 *   - EventBridge Rule: kos.capture / transcript.available → transcript-extractor
 *   - IAM `rds-db:connect` + Bedrock invoke grants
 *
 * Pattern mirrors integrations-notion.ts. Reuses kos-schedules group +
 * schedulerRole from Phase 1 Plan 01-03 when available.
 *
 * Reference:
 *   .planning/phases/06-granola-semantic-memory/06-01-PLAN.md
 *   .planning/phases/06-granola-semantic-memory/06-02-PLAN.md
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as EventsLambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

function loadTranskriptenId(): string {
  const idFile = path.resolve(REPO_ROOT, 'scripts/.notion-db-ids.json');
  if (!fs.existsSync(idFile)) return '';
  const parsed = JSON.parse(fs.readFileSync(idFile, 'utf8')) as Record<string, string>;
  return parsed.transkripten ?? parsed.Transkripten ?? '';
}

export interface WireGranolaProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  notionTokenSecret: ISecret;
  sentryDsnSecret: ISecret;
  langfusePublicKeySecret: ISecret;
  langfuseSecretKeySecret: ISecret;
  captureBus: EventBus;
  agentBus: EventBus;
  scheduleGroupName: string;
  commandCenterDbId: string;
  ownerId: string;
}

export interface GranolaWiring {
  granolaPoller: KosLambda;
  transcriptExtractor: KosLambda;
  schedulerRole: Role;
}

export function wireGranolaIntegrations(
  scope: Construct,
  props: WireGranolaProps,
): GranolaWiring {
  const stack = Stack.of(scope);
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/kos_agent_writer`;

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  const sharedEnv = {
    KOS_OWNER_ID: props.ownerId,
    SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn,
    LANGFUSE_PUBLIC_KEY_SECRET_ARN: props.langfusePublicKeySecret.secretArn,
    LANGFUSE_SECRET_KEY_SECRET_ARN: props.langfuseSecretKeySecret.secretArn,
    DATABASE_HOST: props.rdsProxyEndpoint,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'kos',
    DATABASE_USER: 'kos_agent_writer',
    NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
  };

  // --- granola-poller (CAP-08 + AUTO-05) ------------------------------------
  const granolaPoller = new KosLambda(scope, 'GranolaPoller', {
    entry: svcEntry('granola-poller'),
    timeout: Duration.minutes(2),
    memory: 512,
    ...vpcConfig,
    environment: {
      ...sharedEnv,
      NOTION_TRANSKRIPTEN_DB_ID: loadTranskriptenId(),
      KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
    },
  });
  props.notionTokenSecret.grantRead(granolaPoller);
  props.sentryDsnSecret.grantRead(granolaPoller);
  props.langfusePublicKeySecret.grantRead(granolaPoller);
  props.langfuseSecretKeySecret.grantRead(granolaPoller);
  props.captureBus.grantPutEventsTo(granolaPoller);
  granolaPoller.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  // --- transcript-extractor (AGT-06) ----------------------------------------
  const transcriptExtractor = new KosLambda(scope, 'TranscriptExtractor', {
    entry: svcEntry('transcript-extractor'),
    timeout: Duration.minutes(5),
    memory: 1024,
    ...vpcConfig,
    environment: {
      ...sharedEnv,
      KOS_AGENT_BUS_NAME: props.agentBus.eventBusName,
      NOTION_COMMAND_CENTER_DB_ID: props.commandCenterDbId,
    },
  });
  props.notionTokenSecret.grantRead(transcriptExtractor);
  props.sentryDsnSecret.grantRead(transcriptExtractor);
  props.langfusePublicKeySecret.grantRead(transcriptExtractor);
  props.langfuseSecretKeySecret.grantRead(transcriptExtractor);
  props.agentBus.grantPutEventsTo(transcriptExtractor);
  transcriptExtractor.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  transcriptExtractor.addToRolePolicy(
    new PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/eu.anthropic.claude-sonnet-4-6*',
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
      ],
    }),
  );

  // --- EventBridge rule: transcript.available → transcript-extractor --------
  new Rule(scope, 'TranscriptAvailableRule', {
    eventBus: props.captureBus,
    eventPattern: {
      source: ['kos.capture'],
      detailType: ['transcript.available'],
    },
    targets: [new EventsLambdaFunction(transcriptExtractor)],
  });

  // --- Scheduler role (shared between all Phase 6 schedules) ---------------
  const schedulerRole = new Role(scope, 'GranolaSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  granolaPoller.grantInvoke(schedulerRole);

  // --- Scheduler: granola-poller every 15 min Europe/Stockholm -------------
  new CfnSchedule(scope, 'GranolaPollerSchedule', {
    name: 'kos-granola-poller-15min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'rate(15 minutes)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: granolaPoller.functionArn,
      roleArn: schedulerRole.roleArn,
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
  });

  return { granolaPoller, transcriptExtractor, schedulerRole };
}
