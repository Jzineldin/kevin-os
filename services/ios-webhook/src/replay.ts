/**
 * DynamoDB replay-cache for the iOS webhook (CAP-02 / D-15).
 *
 * Each accepted request's `v1` signature hex is stamped into
 * `kos-ios-webhook-replay` with a 600s TTL on `expires_at`. A duplicate
 * `recordSignature` call returns `{ duplicate: true }` rather than throwing,
 * letting the handler short-circuit with a 409 without leaking error
 * stack-frames into the response.
 *
 * Why 600s when the HMAC drift window is 300s?
 *   - The HMAC tolerance bounds how OLD a request can be (300s past).
 *   - The replay cache bounds the dedupe window — i.e. how long after the
 *     same signature CAN be re-presented before TTL expires it. We pick
 *     2× the drift window (= 600s) so a request signed at the very edge of
 *     the drift window (now-300s) still has a 300s replay-protection tail.
 *
 * Threat mitigation: T-04-IOS-01 (Spoofing — signature replay).
 *
 * The DDB client is module-scoped (one per cold start); the test-only
 * `__resetReplayForTests` exists for symmetry with secrets.ts but doesn't
 * actually need to clear anything because the client is stateless.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';

let client: DynamoDBClient | null = null;
function getClient(): DynamoDBClient {
  if (client) return client;
  client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'eu-north-1',
  });
  return client;
}

/** Default table name; overridden by `REPLAY_TABLE_NAME` env (CDK-injected). */
const DEFAULT_TABLE = 'kos-ios-webhook-replay';

/** TTL in seconds; ±300s HMAC drift × 2 — see file-level JSDoc. */
const TTL_SECONDS = 600;

/**
 * Conditionally-PUT a signature row. Returns `{ duplicate: true }` if the
 * signature was already seen (DDB ConditionalCheckFailedException), else
 * `{ duplicate: false }`. Other DDB errors are rethrown so the handler can
 * fail closed.
 *
 * @param signature  The hex `v1=` value from the X-KOS-Signature header.
 * @param nowSec     Current UNIX seconds. Injected so tests can pin the clock.
 */
export async function recordSignature(
  signature: string,
  nowSec: number,
): Promise<{ duplicate: boolean }> {
  const tableName = process.env.REPLAY_TABLE_NAME ?? DEFAULT_TABLE;
  try {
    await getClient().send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          signature: { S: signature },
          received_at: { N: String(nowSec) },
          expires_at: { N: String(nowSec + TTL_SECONDS) },
        },
        // Idempotent insert — only succeeds if the signature wasn't already
        // stored. The DDB error path is the ONLY mechanism that surfaces
        // duplicates; we MUST treat ConditionalCheckFailedException as a
        // benign "duplicate" rather than a fault.
        ConditionExpression: 'attribute_not_exists(signature)',
      }),
    );
    return { duplicate: false };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { duplicate: true };
    }
    throw err;
  }
}

/** Test-only hook to drop the cached client between tests. */
export function __resetReplayForTests(): void {
  client = null;
}
