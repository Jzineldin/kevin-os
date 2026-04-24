/**
 * Vertex dossier-loader + entity-timeline-refresher wiring (Phase 6).
 *
 * Installs:
 *   - dossier-loader Lambda (INF-10 Vertex Gemini 2.5 Pro)
 *   - entity-timeline-refresher Lambda (MEM-04 MV refresh)
 *   - EventBridge rule: kos.agent / context.full_dossier_requested → dossier-loader
 *   - EventBridge Scheduler: every 5 min, Europe/Stockholm → refresher
 *   - Secrets grants for GCP service-account JSON
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 *            .planning/phases/06-granola-semantic-memory/06-04-PLAN.md
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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireVertexProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  gcpSaJsonSecret: ISecret;
  gcpProjectId: string;
  sentryDsnSecret: ISecret;
  langfusePublicKeySecret: ISecret;
  langfuseSecretKeySecret: ISecret;
  agentBus: EventBus;
  scheduleGroupName: string;
  ownerId: string;
}

export interface VertexWiring {
  dossierLoader: KosLambda;
  timelineRefresher: KosLambda;
  schedulerRole: Role;
}

export function wireVertexIntegrations(
  scope: Construct,
  props: WireVertexProps,
): VertexWiring {
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
  };

  // --- dossier-loader (INF-10) ----------------------------------------------
  const dossierLoader = new KosLambda(scope, 'DossierLoader', {
    entry: svcEntry('dossier-loader'),
    timeout: Duration.minutes(10),
    memory: 2048,
    ...vpcConfig,
    environment: {
      ...sharedEnv,
      GCP_SA_JSON_SECRET_ARN: props.gcpSaJsonSecret.secretArn,
      GCP_PROJECT_ID: props.gcpProjectId,
    },
  });
  props.gcpSaJsonSecret.grantRead(dossierLoader);
  props.sentryDsnSecret.grantRead(dossierLoader);
  props.langfusePublicKeySecret.grantRead(dossierLoader);
  props.langfuseSecretKeySecret.grantRead(dossierLoader);
  dossierLoader.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  new Rule(scope, 'FullDossierRequestedRule', {
    eventBus: props.agentBus,
    eventPattern: {
      source: ['kos.agent'],
      detailType: ['context.full_dossier_requested'],
    },
    targets: [new EventsLambdaFunction(dossierLoader)],
  });

  // --- entity-timeline-refresher (MEM-04) ----------------------------------
  const timelineRefresher = new KosLambda(scope, 'EntityTimelineRefresher', {
    entry: svcEntry('entity-timeline-refresher'),
    timeout: Duration.minutes(2),
    memory: 512,
    ...vpcConfig,
    environment: sharedEnv,
  });
  props.sentryDsnSecret.grantRead(timelineRefresher);
  timelineRefresher.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  const schedulerRole = new Role(scope, 'VertexSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  timelineRefresher.grantInvoke(schedulerRole);

  new CfnSchedule(scope, 'EntityTimelineRefreshSchedule', {
    name: 'kos-entity-timeline-refresh-5min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'rate(5 minutes)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: timelineRefresher.functionArn,
      roleArn: schedulerRole.roleArn,
      retryPolicy: { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 120 },
    },
  });

  return { dossierLoader, timelineRefresher, schedulerRole };
}
