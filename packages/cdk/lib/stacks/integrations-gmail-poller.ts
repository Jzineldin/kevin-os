/**
 * Gmail-poller pipeline wiring (replaces EmailEngine).
 *
 * Surface: `wireGmailPoller` — installs:
 *   - services/gmail-poller Lambda (Node 22 / arm64 / 512 MB / 60 s)
 *   - EventBridge Scheduler entry `gmail-poller-5min`
 *     (`cron(0/5 * * * ? *)` Europe/Stockholm)
 *   - IAM grants:
 *       * secretsmanager:GetSecretValue on kos/gcal-oauth-kevin-elzarka +
 *         kos/gcal-oauth-kevin-taleforge (shared with calendar-reader)
 *       * rds-db:connect as kos_agent_writer (RDS Proxy IAM auth) — for
 *         the idempotency pre-check against email_drafts
 *       * events:PutEvents on the kos.capture bus
 *
 * Read-only by design (gmail.readonly OAuth scope):
 *   - Lambda role has NO bedrock:*, NO ses:*, NO postiz:*, NO notion:*
 *   - CDK test asserts the absence of those grants on the synth output.
 *   - The OAuth refresh_token itself was minted with calendar.readonly +
 *     gmail.readonly only (see scripts/bootstrap-google-oauth.mjs).
 *
 * Secrets are pre-seeded by `scripts/bootstrap-google-oauth.mjs --account
 * kevin-{elzarka,taleforge}`; helper imports them by name.
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
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

export interface WireGmailPollerProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  rdsProxyDbiResourceId: string;
  /** kos.capture bus — gmail-poller emits capture.received here. */
  captureBus: EventBus;
  scheduleGroupName: string;
  kevinOwnerId: string;
  rdsIamUser?: string;
  /** Reuse the calendar-reader / Notion scheduler role to consolidate trust. */
  schedulerRole?: Role;
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  gcalSecretElzarka?: ISecret;
  gcalSecretTaleforge?: ISecret;
}

export interface GmailPollerWiring {
  poller: KosLambda;
  schedule: CfnSchedule;
  schedulerRole: Role;
  gcalSecretElzarka: ISecret;
  gcalSecretTaleforge: ISecret;
}

export function wireGmailPoller(
  scope: Construct,
  props: WireGmailPollerProps,
): GmailPollerWiring {
  const stack = Stack.of(scope);
  const rdsIamUser = props.rdsIamUser ?? 'kos_agent_writer';
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${rdsIamUser}`;

  const gcalSecretElzarka =
    props.gcalSecretElzarka ??
    Secret.fromSecretNameV2(
      scope,
      'GmailPollerOauthElzarkaSecret',
      'kos/gcal-oauth-kevin-elzarka',
    );
  const gcalSecretTaleforge =
    props.gcalSecretTaleforge ??
    Secret.fromSecretNameV2(
      scope,
      'GmailPollerOauthTaleforgeSecret',
      'kos/gcal-oauth-kevin-taleforge',
    );

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  const poller = new KosLambda(scope, 'GmailPoller', {
    entry: svcEntry('gmail-poller'),
    timeout: Duration.seconds(60),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: rdsIamUser,
      DATABASE_NAME: 'kos',
      KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
      GCAL_SECRET_ELZARKA_ARN: gcalSecretElzarka.secretArn,
      GCAL_SECRET_TALEFORGE_ARN: gcalSecretTaleforge.secretArn,
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

  // --- IAM grants ----------------------------------------------------------
  gcalSecretElzarka.grantRead(poller);
  gcalSecretTaleforge.grantRead(poller);
  props.captureBus.grantPutEventsTo(poller);
  poller.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  props.sentryDsnSecret?.grantRead(poller);
  props.langfusePublicKeySecret?.grantRead(poller);
  props.langfuseSecretKeySecret?.grantRead(poller);

  // --- Scheduler role ------------------------------------------------------
  const schedulerRole =
    props.schedulerRole ??
    new Role(scope, 'GmailPollerSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
  poller.grantInvoke(schedulerRole);

  // --- Scheduler entry: gmail-poller-5min ----------------------------------
  // 5-min cadence is the latency target for inbound email arrival. The
  // handler queries Gmail with `newer_than:6m` so each poll overlaps the
  // prior by ~1 min — message_id idempotency at the email_drafts UNIQUE
  // constraint absorbs the duplication.
  const schedule = new CfnSchedule(scope, 'GmailPollerSchedule', {
    name: 'gmail-poller-5min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'cron(0/5 * * * ? *)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: poller.functionArn,
      roleArn: schedulerRole.roleArn,
      input: '{}',
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return { poller, schedule, schedulerRole, gcalSecretElzarka, gcalSecretTaleforge };
}
