/**
 * DynamoDB notification-cap enforcement — RESEARCH Anti-Pattern line 607:
 * every Telegram sender MUST call `enforceAndIncrement` inline. A cap rule
 * bolted on as an upstream EventBridge transformer is the anti-pattern; it
 * can be silently bypassed by any agent that invokes the sender Lambda
 * directly (or by the Phase 2 morning-brief draining `telegram_inbox_queue`).
 *
 * Shape:
 *  - PK = `telegram-cap#YYYY-MM-DD` (Stockholm-local date — D-12)
 *  - Attribute `count` (Number) — incremented ADD +1 per send
 *  - Attribute `ttl`   (Number, epoch seconds, 48h ahead) — DynamoDB TTL
 *    sweeper purges the item after the window, so the table never grows
 *    unboundedly.
 *
 * Concurrency:
 *  - `UpdateItem` with `ADD #c :one` + `ConditionExpression:
 *     attribute_not_exists(#c) OR #c < :max` is atomic on the DynamoDB
 *     single-item path. No read-modify-write race (T-01-CAP-01 accept
 *     disposition).
 *
 * Auth gate ordering:
 *  1. Quiet hours checked FIRST — quiet-hours rejection happens before
 *     we consume a slot, so 4 sends attempted at 22:00 leave `count`
 *     at 0 (all four queue as `quiet-hours`).
 *  2. Cap checked via DynamoDB conditional write (this is the unbypassable
 *     gate during active hours).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isQuietHour, stockholmDateKey } from './quiet-hours.js';

export type CapDenialReason = 'quiet-hours' | 'cap-exceeded';

export interface CapCheckResult {
  allowed: boolean;
  reason?: CapDenialReason;
  /** Post-increment count — only populated on `allowed: true`. */
  count?: number;
}

export interface CapDeps {
  tableName: string;
  /** Daily cap — D-12 default 3. */
  maxPerDay?: number;
  /** Optional injection for tests. */
  ddb?: DynamoDBDocumentClient;
  /** Optional clock for tests. */
  now?: () => Date;
}

/** TTL window for cap rows — 48h is plenty for the daily cap plus slack. */
const TTL_SECONDS = 48 * 3600;

/**
 * Single entry point every Telegram sender imports. Returns
 * `{ allowed: true, count }` on success; `{ allowed: false, reason }` on
 * quiet-hours or cap denial. The caller is responsible for queuing rejected
 * sends into `telegram_inbox_queue` (see handler.ts) so the morning-brief
 * drain can surface them later.
 */
export async function enforceAndIncrement(deps: CapDeps): Promise<CapCheckResult> {
  const now = deps.now ? deps.now() : new Date();
  if (isQuietHour(now)) {
    return { allowed: false, reason: 'quiet-hours' };
  }

  const ddb = deps.ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const max = deps.maxPerDay ?? 3;
  const dateKey = stockholmDateKey(now);
  const ttl = Math.floor(now.getTime() / 1000) + TTL_SECONDS;

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { pk: `telegram-cap#${dateKey}` },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :max',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl, ':max': max },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = (result.Attributes?.count as number | undefined) ?? undefined;
    return { allowed: true, count };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'ConditionalCheckFailedException') {
      return { allowed: false, reason: 'cap-exceeded' };
    }
    throw err;
  }
}
