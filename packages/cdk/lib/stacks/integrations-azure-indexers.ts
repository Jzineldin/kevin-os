/**
 * Azure Search indexers — 4 Lambdas, 4 Schedulers (Phase 6 MEM-03).
 *
 * Each indexer reads a different Postgres source (entities / projects /
 * transcripts agent_runs / daily_brief agent_runs), embeds via Cohere v4,
 * upserts into `kos-memory` Azure Search index.
 *
 * Cadence:
 *   - entities:     every 10 min
 *   - projects:     every 10 min
 *   - transcripts:  every 10 min
 *   - daily-brief:  every 30 min (lower write rate)
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-03-PLAN.md
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
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

export interface WireAzureIndexersProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  azureSearchEndpointSecret: ISecret;
  azureSearchAdminSecret: ISecret;
  sentryDsnSecret: ISecret;
  langfusePublicKeySecret: ISecret;
  langfuseSecretKeySecret: ISecret;
  scheduleGroupName: string;
  ownerId: string;
  azureIndexName?: string;
}

export interface AzureIndexerWiring {
  entities: KosLambda;
  projects: KosLambda;
  transcripts: KosLambda;
  dailyBrief: KosLambda;
  schedulerRole: Role;
}

export function wireAzureIndexers(
  scope: Construct,
  props: WireAzureIndexersProps,
): AzureIndexerWiring {
  const stack = Stack.of(scope);
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/kos_agent_writer`;
  const indexName = props.azureIndexName ?? 'kos-memory';

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
    AZURE_SEARCH_ENDPOINT_SECRET_ARN: props.azureSearchEndpointSecret.secretArn,
    AZURE_SEARCH_ADMIN_SECRET_ARN: props.azureSearchAdminSecret.secretArn,
    AZURE_SEARCH_INDEX_NAME: indexName,
    DATABASE_HOST: props.rdsProxyEndpoint,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'kos',
    DATABASE_USER: 'kos_agent_writer',
  };

  function buildIndexer(name: string, svc: string, timeoutMin: number): KosLambda {
    const fn = new KosLambda(scope, name, {
      entry: svcEntry(svc),
      timeout: Duration.minutes(timeoutMin),
      memory: 768,
      ...vpcConfig,
      environment: sharedEnv,
    });
    props.azureSearchEndpointSecret.grantRead(fn);
    props.azureSearchAdminSecret.grantRead(fn);
    props.sentryDsnSecret.grantRead(fn);
    props.langfusePublicKeySecret.grantRead(fn);
    props.langfuseSecretKeySecret.grantRead(fn);
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [rdsDbConnectResource],
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*:*:inference-profile/eu.cohere.embed-v4*',
          'arn:aws:bedrock:*::foundation-model/cohere.embed-v4*',
        ],
      }),
    );
    return fn;
  }

  const entities = buildIndexer('AzureIndexerEntities', 'azure-search-indexer-entities', 3);
  const projects = buildIndexer('AzureIndexerProjects', 'azure-search-indexer-projects', 3);
  const transcripts = buildIndexer(
    'AzureIndexerTranscripts',
    'azure-search-indexer-transcripts',
    5,
  );
  const dailyBrief = buildIndexer(
    'AzureIndexerDailyBrief',
    'azure-search-indexer-daily-brief',
    3,
  );

  const schedulerRole = new Role(scope, 'AzureIndexerSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  entities.grantInvoke(schedulerRole);
  projects.grantInvoke(schedulerRole);
  transcripts.grantInvoke(schedulerRole);
  dailyBrief.grantInvoke(schedulerRole);

  function buildSchedule(
    name: string,
    targetFn: KosLambda,
    expression: string,
  ): void {
    new CfnSchedule(scope, name, {
      name: `kos-${name.toLowerCase()}`,
      groupName: props.scheduleGroupName,
      scheduleExpression: expression,
      scheduleExpressionTimezone: 'Europe/Stockholm',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: targetFn.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 600 },
      },
    });
  }

  buildSchedule('AzureIndexerEntitiesSchedule', entities, 'rate(10 minutes)');
  buildSchedule('AzureIndexerProjectsSchedule', projects, 'rate(10 minutes)');
  buildSchedule('AzureIndexerTranscriptsSchedule', transcripts, 'rate(10 minutes)');
  buildSchedule('AzureIndexerDailyBriefSchedule', dailyBrief, 'rate(30 minutes)');

  return { entities, projects, transcripts, dailyBrief, schedulerRole };
}
