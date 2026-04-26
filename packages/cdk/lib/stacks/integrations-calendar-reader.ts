/**
 * CAP-09 Google Calendar reader pipeline wiring (Phase 8 Plan 08-01).
 *
 * Surface: `wireCalendarReader` — installs:
 *   - services/calendar-reader Lambda (Node 22 / arm64 / 512 MB / 60 s)
 *   - EventBridge Scheduler entry `calendar-reader-30min`
 *     (`cron(0/30 * * * ? *)` Europe/Stockholm)
 *   - IAM grants:
 *       * secretsmanager:GetSecretValue on kos/gcal-oauth-kevin-elzarka +
 *         kos/gcal-oauth-kevin-taleforge
 *       * rds-db:connect as kos_agent_writer (RDS Proxy IAM auth)
 *       * events:PutEvents on the kos.capture bus
 *
 * Read-only by design (D-04 + threat model T-08-CAL-01):
 *   - OAuth scope on the refresh tokens themselves is `calendar.readonly`
 *   - Lambda role has NO bedrock:*, NO ses:*, NO postiz:*, NO notion:*
 *   - CDK test asserts the absence of those grants on the synth output.
 *
 * Secrets are pre-seeded by `scripts/bootstrap-gcal-oauth.mjs --account
 * kevin-{elzarka,taleforge}`; the helper imports them by name (so secret
 * lifecycle stays operator-owned, not CDK-owned).
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

export interface WireCalendarReaderProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` — from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** kos.capture bus from EventsStack — observability events go here. */
  captureBus: EventBus;
  scheduleGroupName: string;
  /** Single-user UUID Kevin operates as (KEVIN_OWNER_ID). */
  kevinOwnerId: string;
  /** RDS IAM user for `rds-db:connect`. Defaults to 'kos_agent_writer'. */
  rdsIamUser?: string;
  /**
   * Optional re-use of the EventBridge Scheduler role created by the
   * Notion / Granola helpers. If absent, a new role is created scoped to
   * the calendar-reader only.
   */
  schedulerRole?: Role;
  /**
   * Phase 6 D-28 instrumentation. Optional so synth still works in
   * minimal-prop test fixtures.
   */
  sentryDsnSecret?: ISecret;
  langfusePublicKeySecret?: ISecret;
  langfuseSecretKeySecret?: ISecret;
  /**
   * Optional pre-built ISecret references for the OAuth secrets. When
   * absent, the helper resolves them by name via `Secret.fromSecretNameV2`
   * (the secrets themselves are operator-seeded by
   * `scripts/bootstrap-gcal-oauth.mjs`).
   */
  gcalSecretElzarka?: ISecret;
  gcalSecretTaleforge?: ISecret;
}

export interface CalendarReaderWiring {
  reader: KosLambda;
  schedule: CfnSchedule;
  schedulerRole: Role;
  gcalSecretElzarka: ISecret;
  gcalSecretTaleforge: ISecret;
}

/**
 * Plan 08-01 wiring: calendar-reader Lambda + EventBridge Scheduler entry
 * `calendar-reader-30min` (`cron(0/30 * * * ? *)` Europe/Stockholm,
 * mode=OFF).
 *
 * Memory 512 MB / timeout 60 s — both accounts polled in parallel; total
 * wall-clock is dominated by the slower of the two events.list calls plus
 * the UPSERT batch (typically <5 s).
 */
export function wireCalendarReader(
  scope: Construct,
  props: WireCalendarReaderProps,
): CalendarReaderWiring {
  const stack = Stack.of(scope);
  const rdsIamUser = props.rdsIamUser ?? 'kos_agent_writer';
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/${rdsIamUser}`;

  const gcalSecretElzarka =
    props.gcalSecretElzarka ??
    Secret.fromSecretNameV2(scope, 'GcalOauthElzarkaSecret', 'kos/gcal-oauth-kevin-elzarka');
  const gcalSecretTaleforge =
    props.gcalSecretTaleforge ??
    Secret.fromSecretNameV2(scope, 'GcalOauthTaleforgeSecret', 'kos/gcal-oauth-kevin-taleforge');

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // --- calendar-reader Lambda (CAP-09) -------------------------------------
  const reader = new KosLambda(scope, 'CalendarReader', {
    entry: svcEntry('calendar-reader'),
    timeout: Duration.seconds(60),
    memory: 512,
    ...vpcConfig,
    environment: {
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: rdsIamUser,
      DATABASE_NAME: 'kos',
      KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
      // Secret ARN env vars are advisory: the runtime resolves the secret
      // by *name* (kos/gcal-oauth-<account>) so a manual rotate that
      // re-creates the Secret with the same name still works.
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
  // calendar-reader has EXACTLY:
  //   - secretsmanager:GetSecretValue on kos/gcal-oauth-* (2 secrets)
  //   - rds-db:connect as kos_agent_writer
  //   - events:PutEvents on kos.capture
  //   - secretsmanager:GetSecretValue on Sentry / Langfuse (D-28, optional)
  // EXPLICITLY NO bedrock:*, ses:*, postiz:*, notion:*. CDK test asserts.
  gcalSecretElzarka.grantRead(reader);
  gcalSecretTaleforge.grantRead(reader);
  props.captureBus.grantPutEventsTo(reader);
  reader.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  props.sentryDsnSecret?.grantRead(reader);
  props.langfusePublicKeySecret?.grantRead(reader);
  props.langfuseSecretKeySecret?.grantRead(reader);

  // --- Scheduler role ------------------------------------------------------
  const schedulerRole =
    props.schedulerRole ??
    new Role(scope, 'CalendarReaderSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
  reader.grantInvoke(schedulerRole);

  // --- Scheduler entry: calendar-reader-30min ------------------------------
  // D-15: every 30 min, Europe/Stockholm, flexibleTimeWindow OFF.
  // cron(0/30 * * * ? *) fires at :00 and :30 in the Stockholm timezone.
  const schedule = new CfnSchedule(scope, 'CalendarReaderSchedule', {
    name: 'calendar-reader-30min',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'cron(0/30 * * * ? *)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: reader.functionArn,
      roleArn: schedulerRole.roleArn,
      input: '{}',
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return { reader, schedule, schedulerRole, gcalSecretElzarka, gcalSecretTaleforge };
}
