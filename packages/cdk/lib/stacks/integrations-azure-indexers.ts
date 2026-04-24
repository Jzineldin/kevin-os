/**
 * Azure Search indexers — 4 Lambdas, 4 Schedulers (Phase 6 MEM-03).
 *
 * Each indexer reads a different Postgres source (entities / projects /
 * transcripts agent_runs / daily_brief agent_runs), embeds via Cohere v4,
 * upserts into `kos-memory` Azure Search index.
 *
 * Cadence (Plan 06-03 D-09 must_haves: per-content-type cadence so transcripts
 * surface in dossier reads within 5 min of extraction):
 *   - entities:     rate(5 minutes)
 *   - projects:     rate(5 minutes)
 *   - transcripts:  rate(5 minutes)
 *   - daily-brief:  rate(15 minutes)  (lower write rate; Phase 7 source)
 *
 * All schedules: timezone Europe/Stockholm, flexibleTimeWindow OFF, retry
 * policy 2 attempts × 600s max-event-age.
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
  /**
   * `kos/azure-search-admin` JSON secret containing `{endpoint, adminKey}`
   * (matches `services/azure-search-bootstrap` consumption shape and
   * `scripts/provision-azure-search.sh` seeding format). The Phase 6
   * `@kos/azure-search` client unwraps this JSON at cold start.
   */
  azureSearchAdminSecret: ISecret;
  /**
   * Optional secondary endpoint secret (legacy two-secret deployments).
   * When supplied the client falls back to reading the endpoint from this
   * secret if the admin secret is not unified-JSON. Most deployments leave
   * this unset and use the unified admin secret only.
   */
  azureSearchEndpointSecret?: ISecret;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  scheduleGroupName: string;
  ownerId: string;
  azureIndexName?: string;
  /** Optional re-use of an existing scheduler role (mirrors granola pattern). */
  schedulerRole?: Role;
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

  const sharedEnv: Record<string, string> = {
    KOS_OWNER_ID: props.ownerId,
    AZURE_SEARCH_ADMIN_SECRET_ARN: props.azureSearchAdminSecret.secretArn,
    AZURE_SEARCH_INDEX_NAME: indexName,
    DATABASE_HOST: props.rdsProxyEndpoint,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'kos',
    DATABASE_USER: 'kos_agent_writer',
  };
  if (props.azureSearchEndpointSecret) {
    sharedEnv.AZURE_SEARCH_ENDPOINT_SECRET_ARN = props.azureSearchEndpointSecret.secretArn;
  }
  if (props.sentryDsnSecret) {
    sharedEnv.SENTRY_DSN_SECRET_ARN = props.sentryDsnSecret.secretArn;
  }
  if (props.langfusePublicKeySecret) {
    sharedEnv.LANGFUSE_PUBLIC_KEY_SECRET_ARN = props.langfusePublicKeySecret.secretArn;
  }
  if (props.langfuseSecretKeySecret) {
    sharedEnv.LANGFUSE_SECRET_KEY_SECRET_ARN = props.langfuseSecretKeySecret.secretArn;
  }

  function buildIndexer(name: string, svc: string, timeoutMin: number): KosLambda {
    const fn = new KosLambda(scope, name, {
      entry: svcEntry(svc),
      timeout: Duration.minutes(timeoutMin),
      memory: 768,
      ...vpcConfig,
      environment: sharedEnv,
    });
    props.azureSearchAdminSecret.grantRead(fn);
    if (props.azureSearchEndpointSecret) props.azureSearchEndpointSecret.grantRead(fn);
    if (props.sentryDsnSecret) props.sentryDsnSecret.grantRead(fn);
    if (props.langfusePublicKeySecret) props.langfusePublicKeySecret.grantRead(fn);
    if (props.langfuseSecretKeySecret) props.langfuseSecretKeySecret.grantRead(fn);
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

  const schedulerRole = props.schedulerRole ?? new Role(scope, 'AzureIndexerSchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  entities.grantInvoke(schedulerRole);
  projects.grantInvoke(schedulerRole);
  transcripts.grantInvoke(schedulerRole);
  dailyBrief.grantInvoke(schedulerRole);

  function buildSchedule(
    constructId: string,
    scheduleName: string,
    targetFn: KosLambda,
    expression: string,
  ): void {
    new CfnSchedule(scope, constructId, {
      name: scheduleName,
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

  // Plan 06-03 must_haves: per-content-type cadence — entities/projects/
  // transcripts every 5 min, daily-brief every 15 min. Names match the
  // <key_links> grep predicate `azure-search-indexer-(entities|projects|
  // transcripts|daily-brief)`.
  buildSchedule(
    'AzureIndexerEntitiesSchedule',
    'azure-search-indexer-entities',
    entities,
    'rate(5 minutes)',
  );
  buildSchedule(
    'AzureIndexerProjectsSchedule',
    'azure-search-indexer-projects',
    projects,
    'rate(5 minutes)',
  );
  buildSchedule(
    'AzureIndexerTranscriptsSchedule',
    'azure-search-indexer-transcripts',
    transcripts,
    'rate(5 minutes)',
  );
  buildSchedule(
    'AzureIndexerDailyBriefSchedule',
    'azure-search-indexer-daily-brief',
    dailyBrief,
    'rate(15 minutes)',
  );

  return { entities, projects, transcripts, dailyBrief, schedulerRole };
}

/**
 * Plan 06-03 spec name. Alias of `wireAzureIndexers` so callers can use
 * either name without breaking the existing integrations-stack call site.
 */
export const wireAzureSearchIndexers = wireAzureIndexers;
