/**
 * Phase 5 Plan 05-06 — Discord brain-dump Scheduler wiring (CAP-10 half).
 *
 * Per D-09, Phase 5 owns the *scheduling contract* for the Discord
 * `#brain-dump` fallback poller; Phase 10 Plan 10-04 owns the actual
 * Lambda handler (`discord-brain-dump-listener`). This helper only
 * provisions:
 *
 *   1. An IAM Role assumed by `scheduler.amazonaws.com` with
 *      `lambda:InvokeFunction` on the (yet-to-exist) Phase 10 Lambda
 *      ARN, sourced from SSM parameter `/kos/discord/brain-dump-lambda-arn`.
 *   2. An EventBridge `CfnSchedule` named `kos-discord-poll` that fires
 *      every 5 minutes UTC and invokes that ARN with a static input
 *      payload documented in `05-06-DISCORD-CONTRACT.md`.
 *
 * The SSM parameter is operator-seeded:
 *   - If Phase 10 has not landed: seed with a no-op Lambda ARN (the
 *     Scheduler then fires every 5 min and exits 200 — fail-quiet).
 *   - Once Phase 10 lands: Plan 10-04 updates the SSM param. A second
 *     CDK deploy is required for the Scheduler to pin the new ARN
 *     (Scheduler target is resolved at rule-creation time, NOT runtime).
 *
 * Reference:
 *   .planning/phases/05-messaging-channels/05-06-PLAN.md
 *   .planning/phases/05-messaging-channels/05-06-DISCORD-CONTRACT.md
 *   .planning/phases/10-migration-decommission/10-04-PLAN.md
 */
import type { Construct } from 'constructs';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

export interface WireDiscordScheduleProps {
  /**
   * Single-user UUID Kevin operates as (KEVIN_OWNER_ID). Embedded into
   * the static Scheduler input payload so the Phase 10 Lambda can stamp
   * `owner_id` onto each emitted `capture.received` without re-deriving
   * it from environment.
   */
  kevinOwnerId: string;
  /**
   * Optional SSM parameter name override. Defaults to the contract's
   * canonical name `/kos/discord/brain-dump-lambda-arn`.
   */
  brainDumpLambdaArnParamName?: string;
}

export interface DiscordScheduleWiring {
  schedulerRole: Role;
  schedule: CfnSchedule;
  brainDumpLambdaArnParamName: string;
}

/**
 * Provisions the EventBridge Scheduler entry + IAM role for the Discord
 * brain-dump fallback poller. Phase 10 Plan 10-04 owns the Lambda — this
 * helper only pre-wires the schedule against an SSM-sourced ARN.
 */
export function wireDiscordSchedule(
  scope: Construct,
  props: WireDiscordScheduleProps,
): DiscordScheduleWiring {
  const paramName = props.brainDumpLambdaArnParamName ?? '/kos/discord/brain-dump-lambda-arn';

  // --- SSM-sourced Lambda ARN ----------------------------------------------
  // `fromStringParameterName` returns a token; CloudFormation resolves it
  // at deploy time. The Phase 10 Lambda may not yet exist at Phase 5
  // execute-time — operator pre-seeds the param with either a no-op ARN
  // (deploy unblock) or the real ARN once Phase 10 ships.
  const arnParam = StringParameter.fromStringParameterName(
    scope,
    'DiscordBrainDumpLambdaArn',
    paramName,
  );

  // --- Scheduler role ------------------------------------------------------
  // Trust scheduler.amazonaws.com; no aws:SourceArn condition (Phase 1
  // Plan 02-04 retro pitfall: scheduler validates the role at
  // schedule-creation time before the schedule ARN exists). Blast radius
  // is the SSM-resolved ARN only — the policy resource scopes invocation
  // to whatever the parameter currently points at.
  const schedulerRole = new Role(scope, 'DiscordScheduleRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  schedulerRole.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [arnParam.stringValue],
    }),
  );

  // --- Scheduler entry: kos-discord-poll -----------------------------------
  // cron(0/5 * * * ? *) UTC = every 5 min on the hour, regardless of
  // timezone (Discord messages are timezone-neutral). FlexibleTimeWindow
  // OFF for predictable cadence; retryPolicy mirrors Phase 1 patterns
  // (2 retries, 5-min event-age cutoff).
  const schedule = new CfnSchedule(scope, 'DiscordBrainDumpSchedule', {
    name: 'kos-discord-poll',
    scheduleExpression: 'cron(0/5 * * * ? *)',
    scheduleExpressionTimezone: 'UTC',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: arnParam.stringValue,
      roleArn: schedulerRole.roleArn,
      input: JSON.stringify({
        // Static contract consumed by the Phase 10 Lambda — see
        // 05-06-DISCORD-CONTRACT.md for the full input/output spec.
        channel: 'brain-dump',
        owner_id: props.kevinOwnerId,
        trigger_source: 'kos-discord-poll-scheduler',
      }),
      retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
    },
    state: 'ENABLED',
  });

  return { schedulerRole, schedule, brainDumpLambdaArnParamName: paramName };
}
