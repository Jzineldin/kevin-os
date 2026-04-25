/**
 * Vertex dossier-loader wiring (Phase 6 Plan 06-05 INF-10).
 *
 * Installs:
 *   - dossier-loader Lambda (Vertex Gemini 2.5 Pro europe-west4)
 *   - EventBridge rule: kos.agent / context.full_dossier_requested → dossier-loader
 *   - Secrets Manager grants for GCP service-account JSON (kos/gcp-vertex-sa)
 *   - rds-db:connect IAM grant on the RDS Proxy DBI
 *
 * The entity-timeline-refresher Lambda is owned by Plan 06-04
 * (`integrations-mv-refresher.ts::wireMvRefresher`); this helper does NOT
 * create it (avoids construct-id collision in the same stack).
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as EventsLambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireDossierLoaderProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` — from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** `kos/gcp-vertex-sa` Secrets Manager entry holding the SA JSON. */
  gcpSaJsonSecret: ISecret;
  /** GCP project hosting the Vertex SA (e.g. `kos-vertex-prod`). */
  gcpProjectId: string;
  agentBus: EventBus;
  ownerId: string;
  /** RDS IAM user for `rds-db:connect`. Defaults to 'kos_agent_writer'. */
  rdsIamUser?: string;
  /** D-28 instrumentation. Optional so synth still works in minimal-prop fixtures. */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
}

export interface DossierLoaderWiring {
  dossierLoader: KosLambda;
  rule: Rule;
}

/**
 * Plan 06-05 wiring: dossier-loader Lambda + EventBridge rule on
 * `context.full_dossier_requested` (kos.agent bus).
 *
 * Memory 2 GB / timeout 10 min — Vertex Gemini 2.5 Pro calls can run 60-90s
 * for 800k-token corpus + we add buffer for cold-start cred fetch + RDS
 * Proxy connection.
 */
export function wireDossierLoader(
  scope: Construct,
  props: WireDossierLoaderProps,
): DossierLoaderWiring {
  const stack = Stack.of(scope);
  const rdsIamUser = props.rdsIamUser ?? 'kos_agent_writer';
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${rdsIamUser}`;

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  const dossierLoader = new KosLambda(scope, 'DossierLoader', {
    entry: svcEntry('dossier-loader'),
    timeout: Duration.minutes(10),
    memory: 2048,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.ownerId,
      KOS_OWNER_ID: props.ownerId,
      DATABASE_HOST: props.rdsProxyEndpoint,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'kos',
      DATABASE_USER: rdsIamUser,
      RDS_IAM_USER: rdsIamUser,
      GCP_SA_JSON_SECRET_ARN: props.gcpSaJsonSecret.secretArn,
      GCP_PROJECT_ID: props.gcpProjectId,
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

  props.gcpSaJsonSecret.grantRead(dossierLoader);
  props.sentryDsnSecret?.grantRead(dossierLoader);
  props.langfusePublicKeySecret?.grantRead(dossierLoader);
  props.langfuseSecretKeySecret?.grantRead(dossierLoader);

  dossierLoader.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  const rule = new Rule(scope, 'FullDossierRequestedRule', {
    eventBus: props.agentBus,
    eventPattern: {
      source: ['kos.agent'],
      detailType: ['context.full_dossier_requested'],
    },
    targets: [new EventsLambdaFunction(dossierLoader)],
  });

  return { dossierLoader, rule };
}
