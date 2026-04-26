/**
 * @kos/service-discord-brain-dump — DynamoDB cursor for #brain-dump poll.
 *
 * The Phase 5 Plan 05-06 EventBridge Scheduler (`kos-discord-poll`) fires
 * this Lambda every 5 minutes. Each fire reads the last-seen Discord
 * message ID per channel from a DynamoDB table, calls Discord's REST API
 * with `?after=<last_id>`, then writes the new high-water-mark back to the
 * cursor table.
 *
 * Schema:
 *   pk        STRING  channel_id (Discord channel snowflake)
 *   messageId STRING  last successfully processed Discord message ID
 *   updatedAt STRING  ISO 8601 timestamp of the last write
 *   ttl       NUMBER  epoch seconds — 30 days from last write (safety net
 *                     so dormant channels do not pin storage forever)
 *
 * Concurrency model: at-most-one Scheduler fire is in flight per Lambda
 * concurrency limit (=1 in the CDK wiring). PutItem with no
 * ConditionExpression is therefore last-write-wins — safe because each
 * fire processes monotonically newer Discord messages.
 *
 * Wave 0 ships the cursor module ready-to-use; Plan 10-04 (Wave 4 owner of
 * CAP-10) imports `getCursor` + `setCursor` directly.
 */
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

/** 30 days in seconds — TTL safety floor. */
const CURSOR_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Translation options the doc client accepts at construction. Inlined
 * (rather than imported) because the AWS SDK does not export a public type
 * alias for the second argument of `DynamoDBDocumentClient.from`.
 */
interface DocClientFromOptions {
  marshallOptions?: {
    convertEmptyValues?: boolean;
    removeUndefinedValues?: boolean;
    convertClassInstanceToMap?: boolean;
  };
  unmarshallOptions?: {
    wrapNumbers?: boolean;
  };
}

/**
 * Build a `DynamoDBDocumentClient`. Exported so tests can swap the inner
 * `DynamoDBClient` for an in-memory mock without monkey-patching the SDK.
 */
export function makeDocClient(
  client?: DynamoDBClient,
  options: DocClientFromOptions = {},
): DynamoDBDocumentClient {
  const cfg: DynamoDBClientConfig = {
    region: process.env.AWS_REGION ?? 'eu-north-1',
  };
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true },
    ...options,
  });
}

export interface CursorRow {
  pk: string;
  messageId: string;
  updatedAt: string;
  ttl: number;
}

export interface GetCursorOptions {
  tableName?: string;
  client?: DynamoDBDocumentClient;
}

export interface SetCursorOptions extends GetCursorOptions {
  /** Used by tests to pin the time stamps; defaults to `Date.now()`. */
  now?: () => number;
}

function tableName(opts: GetCursorOptions): string {
  const t = opts.tableName ?? process.env.CURSOR_TABLE_NAME;
  if (!t) {
    throw new Error(
      'discord-brain-dump cursor: CURSOR_TABLE_NAME env var (or tableName option) is required',
    );
  }
  return t;
}

/**
 * Read the last-seen message ID for `channelId`. Returns `null` for a
 * cold-start channel (table miss).
 */
export async function getCursor(
  channelId: string,
  opts: GetCursorOptions = {},
): Promise<string | null> {
  const doc = opts.client ?? makeDocClient();
  const out = await doc.send(
    new GetCommand({
      TableName: tableName(opts),
      Key: { pk: channelId },
      ConsistentRead: true,
    }),
  );
  const item = out.Item as CursorRow | undefined;
  return item?.messageId ?? null;
}

/**
 * Last-write-wins cursor update. Refreshes the TTL on every write so an
 * actively used channel never expires; abandoned channels purge after 30
 * days to keep the table tidy.
 */
export async function setCursor(
  channelId: string,
  messageId: string,
  opts: SetCursorOptions = {},
): Promise<void> {
  const doc = opts.client ?? makeDocClient();
  const nowMs = (opts.now ?? Date.now)();
  const item: CursorRow = {
    pk: channelId,
    messageId,
    updatedAt: new Date(nowMs).toISOString(),
    ttl: Math.floor(nowMs / 1000) + CURSOR_TTL_SECONDS,
  };
  await doc.send(
    new PutCommand({
      TableName: tableName(opts),
      Item: item,
    }),
  );
}
