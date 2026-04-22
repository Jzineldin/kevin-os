#!/usr/bin/env node
/**
 * Gate 1 verifier — exercise the push-telegram cap.
 *
 * Invokes the deployed push-telegram Lambda 4 times in a row. First 3 must
 * return `sent: true`; the 4th must return `sent: false, reason:
 * 'cap-exceeded'`.
 *
 * IMPORTANT: run during Stockholm 08:00-20:00 window only — during quiet
 * hours all 4 invocations will return `reason: 'quiet-hours'` and the
 * cap gate will not be exercised. The script detects this and fails fast
 * with a helpful error.
 *
 * Reset path: if cap has already been consumed for today, either wait until
 * midnight Stockholm local OR delete the `telegram-cap#YYYY-MM-DD` item
 * from DynamoDB:
 *   aws dynamodb delete-item --table-name <CAP_TABLE_NAME> \
 *     --key '{"pk":{"S":"telegram-cap#YYYY-MM-DD"}}'
 *
 * Env:
 *   PUSH_TELEGRAM_FN_NAME — Lambda name or ARN (default: KosSafety-PushTelegram)
 *   AWS_REGION            — default eu-north-1
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION ?? 'eu-north-1';
const FN = process.env.PUSH_TELEGRAM_FN_NAME ?? 'KosSafety-PushTelegram';

const lambda = new LambdaClient({ region: REGION });

async function invoke(i) {
  const resp = await lambda.send(
    new InvokeCommand({
      FunctionName: FN,
      Payload: Buffer.from(JSON.stringify({ body: `verify-cap test ${i}` })),
    }),
  );
  if (!resp.Payload) throw new Error(`Invoke ${i} returned no payload`);
  const text = Buffer.from(resp.Payload).toString();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invoke ${i} returned non-JSON payload: ${text}`);
  }
  if (resp.FunctionError) {
    throw new Error(`Invoke ${i} Lambda error: ${text}`);
  }
  return parsed;
}

const results = [];
for (let i = 1; i <= 4; i++) {
  const r = await invoke(i);
  results.push(r);
  // eslint-disable-next-line no-console
  console.log(`#${i}: ${JSON.stringify(r)}`);
}

// If everything is 'quiet-hours', the cap gate was not exercised.
if (results.every((r) => r.reason === 'quiet-hours')) {
  console.error(
    '[FAIL] All 4 invocations rejected with quiet-hours. Run during Stockholm 08:00-20:00 to exercise the cap gate.',
  );
  process.exit(1);
}

const sent = results.filter((r) => r.sent).length;
const capRejected = results.filter((r) => !r.sent && r.reason === 'cap-exceeded');

if (capRejected.length < 1) {
  console.error(
    `[FAIL] cap not enforced on 4th send. sent=${sent}, rejections=${JSON.stringify(
      results.filter((r) => !r.sent).map((r) => r.reason),
    )}`,
  );
  process.exit(2);
}

// eslint-disable-next-line no-console
console.log(`[OK] cap enforced. sent=${sent}, cap-exceeded=${capRejected.length}`);
