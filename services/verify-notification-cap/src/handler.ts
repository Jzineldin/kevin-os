/**
 * Phase 7 Plan 07-04 — verify-notification-cap Lambda (D-07).
 *
 * Scheduled via CfnSchedule cron(0 3 ? * SUN *) Europe/Stockholm — the weekly
 * compliance check fires at Sunday 03:00 Stockholm, BEFORE Sunday's 19:00
 * weekly-review brief, so a cap violation surfaces in the same morning batch.
 *
 * Flow:
 *   1. initSentry + setupOtelTracingAsync (matches every other Phase 7 Lambda).
 *   2. Generate run_id (ulid) for trace correlation.
 *   3. Load 14-day cap snapshots (SQL + DynamoDB).
 *   4. Load 14-day quiet-hours violations (SQL).
 *   5. If ANY violations:
 *        - Publish SNS to ALARM_TOPIC_ARN (SafetyStack alarmTopic → email).
 *        - PutEvents kos.system / brief.compliance_violation.
 *   6. Always return { healthy, run_id, run_at, cap_violations[],
 *      quiet_hours_violations[] }.
 *
 * Read-only — no side effects on RDS or DynamoDB. The IAM grants are
 * structurally minimal: rds-db:connect on kos_admin, dynamodb:GetItem (via
 * grantReadData), sns:Publish on alarmTopic, events:PutEvents on systemBus
 * (verified by CDK tests in Plan 07-04 Task 3).
 *
 * Always returns; never throws (operator alarm best-effort). EventBridge
 * Scheduler retries on Lambda errors, but compliance signal must surface even
 * if we can't reach SNS/EventBridge — operator can also run the same logic
 * locally via scripts/verify-notification-cap-14day.mjs (Task 2).
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { ulid } from 'ulid';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

import { getPool } from './pool.js';
import {
  loadCapSnapshots14Days,
  loadQuietHoursViolations14Days,
  type CapDaySnapshot,
  type QuietHoursViolation,
} from './queries.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const region = process.env.AWS_REGION ?? 'eu-north-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const sns = new SNSClient({ region });
const eb = new EventBridgeClient({ region });

interface VerifyResult {
  healthy: boolean;
  run_id: string;
  run_at: string;
  cap_violations: Array<{
    stockholm_date: string;
    push_ok_count: number;
    cap_table_count: number | null;
  }>;
  quiet_hours_violations: Array<{
    at: string;
    stockholm_hour: number;
    capture_id?: string;
  }>;
}

export const handler = wrapHandler(async (_event: unknown): Promise<VerifyResult> => {
  await initSentry();
  await setupOtelTracingAsync();

  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');
  const capTableName = process.env.CAP_TABLE_NAME;
  if (!capTableName) throw new Error('CAP_TABLE_NAME not set');

  const runId = ulid();
  const runAt = new Date().toISOString();
  tagTraceWithCaptureId(runId);

  try {
    const pool = await getPool();

    // 1. Load cap snapshots + quiet-hours violations in parallel.
    const [snapshots, quietHourRows] = await Promise.all([
      loadCapSnapshots14Days(pool, ddb, capTableName, ownerId),
      loadQuietHoursViolations14Days(pool, ownerId),
    ]);

    const capViolations = snapshots
      .filter((s: CapDaySnapshot) => s.violation)
      .map((s) => ({
        stockholm_date: s.stockholmDate,
        push_ok_count: s.pushOkCount,
        cap_table_count: s.capTableCount,
      }));

    const quietHoursViolations = quietHourRows.map((q: QuietHoursViolation) => ({
      at: q.at,
      stockholm_hour: q.stockholmHour,
      capture_id: q.capture_id,
    }));

    const healthy = capViolations.length === 0 && quietHoursViolations.length === 0;

    // 2. On any violation: SNS publish + EventBridge brief.compliance_violation.
    if (!healthy) {
      const alarmTopicArn = process.env.ALARM_TOPIC_ARN;
      if (alarmTopicArn) {
        try {
          const summary = formatViolationSummary({
            runId,
            runAt,
            capViolations,
            quietHoursViolations,
          });
          await sns.send(
            new PublishCommand({
              TopicArn: alarmTopicArn,
              Subject: 'KOS Phase 7 — notification compliance violation',
              Message: summary,
            }),
          );
        } catch (err) {
          console.error('[verify-cap] SNS publish failed (operator alarm best-effort):', err);
        }
      } else {
        console.warn('[verify-cap] ALARM_TOPIC_ARN not set — skipping SNS publish');
      }

      try {
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: process.env.SYSTEM_BUS_NAME ?? 'kos.system',
                Source: 'kos.system',
                DetailType: 'brief.compliance_violation',
                Detail: JSON.stringify({
                  run_id: runId,
                  run_at: runAt,
                  cap_violations: capViolations,
                  quiet_hours_violations: quietHoursViolations,
                }),
              },
            ],
          }),
        );
      } catch (err) {
        console.error('[verify-cap] PutEvents brief.compliance_violation failed:', err);
      }
    }

    return {
      healthy,
      run_id: runId,
      run_at: runAt,
      cap_violations: capViolations,
      quiet_hours_violations: quietHoursViolations,
    };
  } finally {
    await langfuseFlush();
  }
});

function formatViolationSummary(args: {
  runId: string;
  runAt: string;
  capViolations: Array<{ stockholm_date: string; push_ok_count: number; cap_table_count: number | null }>;
  quietHoursViolations: Array<{ at: string; stockholm_hour: number; capture_id?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`KOS notification-cap weekly compliance check FAILED.`);
  lines.push(`run_id=${args.runId}`);
  lines.push(`run_at=${args.runAt}`);
  lines.push('');
  if (args.capViolations.length > 0) {
    lines.push(`Cap violations (>3 push-telegram runs / Stockholm day):`);
    for (const v of args.capViolations) {
      lines.push(
        `  ${v.stockholm_date}  pushes=${v.push_ok_count}  ddb_count=${v.cap_table_count ?? '—'}`,
      );
    }
    lines.push('');
  }
  if (args.quietHoursViolations.length > 0) {
    lines.push(`Quiet-hours violations (push-telegram inside 20:00-08:00 Stockholm):`);
    for (const v of args.quietHoursViolations) {
      lines.push(
        `  ${v.at}  stockholm_hour=${v.stockholm_hour}  capture_id=${v.capture_id ?? '—'}`,
      );
    }
  }
  return lines.join('\n');
}
