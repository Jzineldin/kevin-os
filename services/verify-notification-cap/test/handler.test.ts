/**
 * Phase 7 Plan 07-04 Task 1 — handler.ts unit tests (TDD RED).
 *
 * Verifies the weekly compliance-check Lambda:
 *   - Happy path (no violations) → SNS not called; return { healthy: true }.
 *   - Violation detected → SNS publish + EventBridge brief.compliance_violation;
 *     return { healthy: false, ... }.
 *   - DynamoDB Query fails → fallback to SQL-only snapshot (capTableCount=null);
 *     handler still completes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const snsPublish = vi.fn();
vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: class {
    send = snsPublish;
  },
  PublishCommand: class PublishCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const ebSend = vi.fn();
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = ebSend;
  },
  PutEventsCommand: class PutEventsCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const ddbSend = vi.fn();
vi.mock('@aws-sdk/lib-dynamodb', async () => {
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send: ddbSend }),
    },
    GetCommand: class GetCommand {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {},
}));

const loadCapSnapshots14DaysMock = vi.fn();
const loadQuietHoursViolations14DaysMock = vi.fn();
vi.mock('../src/queries.js', () => ({
  loadCapSnapshots14Days: loadCapSnapshots14DaysMock,
  loadQuietHoursViolations14Days: loadQuietHoursViolations14DaysMock,
}));

const getPoolMock = vi.fn(async () => ({}) as never);
vi.mock('../src/pool.js', () => ({
  getPool: getPoolMock,
}));

vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => undefined),
  wrapHandler: <T extends (...args: any[]) => any>(fn: T) => fn,
}));

vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracingAsync: vi.fn(async () => undefined),
  flush: vi.fn(async () => undefined),
  tagTraceWithCaptureId: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KEVIN_OWNER_ID = 'owner-1';
  process.env.CAP_TABLE_NAME = 'cap-table';
  process.env.ALARM_TOPIC_ARN = 'arn:aws:sns:eu-north-1:123:alarm';
  process.env.SYSTEM_BUS_NAME = 'kos.system';
  process.env.RDS_PROXY_ENDPOINT = 'rds.example.com';
  process.env.RDS_IAM_USER = 'kos_admin';
  snsPublish.mockResolvedValue({});
  ebSend.mockResolvedValue({});
});

describe('verify-notification-cap handler', () => {
  it('happy path (no violations): SNS not called; returns { healthy: true }', async () => {
    loadCapSnapshots14DaysMock.mockResolvedValue([
      { stockholmDate: '2026-04-25', pushOkCount: 2, capTableCount: 2, violation: false },
      { stockholmDate: '2026-04-24', pushOkCount: 1, capTableCount: 1, violation: false },
    ]);
    loadQuietHoursViolations14DaysMock.mockResolvedValue([]);

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)({})) as {
      healthy: boolean;
      cap_violations: unknown[];
      quiet_hours_violations: unknown[];
    };

    expect(result.healthy).toBe(true);
    expect(result.cap_violations).toHaveLength(0);
    expect(result.quiet_hours_violations).toHaveLength(0);
    expect(snsPublish).not.toHaveBeenCalled();
    // No compliance_violation event either.
    const violationEvents = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as { input?: { Entries?: { DetailType?: string }[] } }).input?.Entries ?? [];
      return entries.some((e) => e.DetailType === 'brief.compliance_violation');
    });
    expect(violationEvents).toHaveLength(0);
  });

  it('violation detected: SNS publish called once + brief.compliance_violation emitted; returns { healthy: false }', async () => {
    loadCapSnapshots14DaysMock.mockResolvedValue([
      { stockholmDate: '2026-04-25', pushOkCount: 5, capTableCount: 5, violation: true },
      { stockholmDate: '2026-04-24', pushOkCount: 1, capTableCount: 1, violation: false },
    ]);
    loadQuietHoursViolations14DaysMock.mockResolvedValue([
      { at: '2026-04-22T22:30:00.000Z', stockholmHour: 23, capture_id: 'cap-late' },
    ]);

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)({})) as {
      healthy: boolean;
      cap_violations: { stockholm_date: string; push_ok_count: number }[];
      quiet_hours_violations: { stockholm_hour: number }[];
    };

    expect(result.healthy).toBe(false);
    expect(result.cap_violations).toHaveLength(1);
    expect(result.cap_violations[0]?.stockholm_date).toBe('2026-04-25');
    expect(result.cap_violations[0]?.push_ok_count).toBe(5);
    expect(result.quiet_hours_violations).toHaveLength(1);

    expect(snsPublish).toHaveBeenCalledTimes(1);
    const violationEvents = ebSend.mock.calls.filter((c) => {
      const entries = (c[0] as { input?: { Entries?: { DetailType?: string }[] } }).input?.Entries ?? [];
      return entries.some((e) => e.DetailType === 'brief.compliance_violation');
    });
    expect(violationEvents).toHaveLength(1);
  });

  it('DynamoDB Query failure tolerated: cap snapshots still load via SQL; handler completes', async () => {
    // queries.ts swallows DynamoDB errors and returns snapshots with
    // capTableCount=null. Handler must not crash.
    loadCapSnapshots14DaysMock.mockResolvedValue([
      { stockholmDate: '2026-04-25', pushOkCount: 2, capTableCount: null, violation: false },
    ]);
    loadQuietHoursViolations14DaysMock.mockResolvedValue([]);

    const { handler } = await import('../src/handler.js');
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)({})) as {
      healthy: boolean;
      cap_violations: unknown[];
    };
    expect(result.healthy).toBe(true);
    expect(result.cap_violations).toHaveLength(0);
  });
});
