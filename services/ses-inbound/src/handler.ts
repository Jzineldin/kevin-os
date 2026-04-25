/**
 * @kos/service-ses-inbound — CAP-03 (forward@kos.tale-forge.app inbound mail).
 *
 * Pipeline: SES (eu-west-1) drops raw RFC 5322 MIME into S3 (eu-west-1) and
 * synchronously invokes this Lambda (eu-north-1). The Lambda fetches the
 * email cross-region (eu-north-1 → eu-west-1 GetObject), parses with
 * mailparser, and emits `capture.received` on the `kos.capture` bus. The
 * Phase 2 triage Lambda picks up unchanged.
 *
 * Plan 04-02. Realises CAP-03 (forwarded-email capture) and the Phase 4
 * D-13 region-asymmetry decision (SES inbound only operates in eu-west-1;
 * everything else lives in eu-north-1).
 *
 * Threat mitigations encoded structurally in this file:
 *  - T-04-SES-02 (tampering): Lambda permission grants ses.amazonaws.com
 *    invoke with SourceAccount condition (CDK side); we trust the action
 *    union here is `S3` and skip the alternative branches without invoking
 *    GetObject if the shape doesn't match.
 *  - T-04-SES-05 (prompt-injection EoP): we surface raw content to
 *    EventBridge unchanged but pass it through Zod validation before emit;
 *    classification + refusal happen at email-triage. No Bedrock call here.
 *  - P-11 (dead-letter loops): EventBridge PutEvents goes through
 *    `withTimeoutAndRetry`; the dead-letter side-effects themselves are
 *    NEVER re-wrapped (the helper enforces this).
 *  - SES retry idempotency: capture_id is derived as a 26-char Crockford
 *    digest of sha256(message_id), so a duplicate Lambda invocation for the
 *    same email produces an identical event detail — downstream dedupes
 *    naturally on capture_id (Phase 2 triage already does this).
 *
 * Constraints not handled here (operator runbook 04-SES-OPERATOR-RUNBOOK.md):
 *  - SES domain verification + DKIM CNAMEs.
 *  - MX record on kos.tale-forge.app pointing at inbound-smtp.eu-west-1.
 *  - SES receiving rule set + rule that S3-Action's into the bucket.
 *  - The cross-region S3 bucket itself (`kos-ses-inbound-euw1-<account>`).
 *
 * The CDK helper provisions the Lambda + IAM; everything in eu-west-1 is
 * out-of-band per RESEARCH §1.
 */
import { createHash } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import { setupOtelTracingAsync, flush as langfuseFlush, tagTraceWithCaptureId } from '../../_shared/tracing.js';
import { withTimeoutAndRetry } from '../../_shared/with-timeout-retry.js';
import { CaptureReceivedEmailForwardSchema } from '@kos/contracts';
import { parseRawEmail } from './parse.js';

// AWS_REGION default — Lambda runtime sets this; the fallback only matters in
// local-test invocation paths that import this module before the env is set.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

// Two clients with explicit, asymmetric regions:
//  - eu-north-1 EventBridge for the kos.capture bus emit.
//  - eu-west-1 S3 for the cross-region GetObject. SES inbound is only
//    available in eu-west-1, so the bucket is pinned there (D-13).
const eb = new EventBridgeClient({ region: 'eu-north-1' });
const s3EuWest = new S3Client({ region: 'eu-west-1' });

/** Crockford base32 alphabet (no I, L, O, U) — matches the ULID spec. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Derive a 26-char ULID-shaped string from a Message-ID.
 *
 * NOT a true ULID — the timestamp prefix is not embedded. The string only
 * needs to satisfy the `UlidRegex` (`/^[0-9A-HJKMNP-TV-Z]{26}$/`) used by
 * `CaptureReceivedEmailForwardSchema` and remain stable across SES retries
 * for the same email (the SES retry policy can re-invoke this Lambda for the
 * same S3 object up to 5 times — downstream dedupe relies on identical
 * capture_id between attempts).
 *
 * sha256 → 32 bytes; we map the first 26 bytes through `byte % 32` into the
 * Crockford alphabet. Modulo bias is acceptable for an idempotency key (we
 * don't need uniform random distribution; we need a stable function).
 */
function deterministicCaptureIdFromMessageId(messageId: string): string {
  const hash = createHash('sha256').update(messageId, 'utf8').digest();
  let out = '';
  for (let i = 0; i < 26; i++) {
    // Non-null assertion: hash is 32 bytes, i is 0..25 so always defined.
    out += CROCKFORD[hash[i]! % 32];
  }
  return out;
}

/** Test-only export so unit tests can assert determinism without re-implementing. */
export const __test = { deterministicCaptureIdFromMessageId };

/** Single-record SES action shape — receipt.action is a tagged union. */
interface SesS3Action {
  type: 'S3';
  bucketName: string;
  objectKey: string;
}
interface SesLambdaEventRecord {
  ses: {
    mail: {
      commonHeaders?: { messageId?: string };
    };
    receipt: {
      action: { type: string; bucketName?: string; objectKey?: string };
    };
  };
}
interface SesLambdaEvent {
  Records?: SesLambdaEventRecord[];
}

/**
 * Drain an S3 GetObject body stream into a Buffer. Lambda's runtime gives us
 * an AsyncIterable<Uint8Array>; smaller objects (< 256KB typical email) fit
 * in memory without backpressure concerns.
 */
async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error('S3 GetObject returned empty body');
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const handler = wrapHandler(async (event: SesLambdaEvent) => {
  await initSentry();
  // Best-effort tracing setup; failure is logged inside the helper, so we
  // proceed unconditionally. Langfuse outage MUST NOT block ingest.
  await setupOtelTracingAsync();

  if (!event.Records || event.Records.length === 0) {
    throw new Error('ses-inbound: no Records in event (malformed SES invocation)');
  }

  const ownerId =
    process.env.KEVIN_OWNER_ID ?? '00000000-0000-0000-0000-000000000000';

  const results: Array<{ capture_id: string; message_id: string }> = [];

  // SES batches are almost always 1 record in practice, but the API allows N.
  for (const rec of event.Records) {
    const action = rec.ses?.receipt?.action;
    if (!action || action.type !== 'S3' || !action.bucketName || !action.objectKey) {
      // Non-S3 actions (Lambda-only, SNS, etc.) are not part of CAP-03.
      // Skip without throwing so a misconfigured rule set doesn't black-hole
      // the Lambda; CloudWatch logs surface the skip for the operator.
      console.warn('[ses-inbound] skipping non-S3 action', { type: action?.type });
      continue;
    }
    const s3Action = action as SesS3Action;

    // Fetch the raw email cross-region. mailparser handles transfer-encoding
    // (base64, quoted-printable) and multipart structure — we just hand it
    // the raw bytes.
    const obj = await s3EuWest.send(
      new GetObjectCommand({ Bucket: s3Action.bucketName, Key: s3Action.objectKey }),
    );
    const raw = await streamToBuffer(obj.Body);

    const parsed = await parseRawEmail(raw);
    const captureId = deterministicCaptureIdFromMessageId(parsed.messageId);
    // Tag the active OTel span so cross-agent invocations (triage → resolver)
    // group on capture_id in Langfuse.
    tagTraceWithCaptureId(captureId);

    // Build + validate the EventBridge detail. Zod parse here is the structural
    // T-04-SES-05 mitigation: any field that doesn't match (e.g. truncated
    // body, malformed date) fails before we touch EventBridge.
    const detail = CaptureReceivedEmailForwardSchema.parse({
      capture_id: captureId,
      channel: 'email-forward',
      kind: 'email_forward',
      email: {
        message_id: parsed.messageId,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        body_text: parsed.bodyText,
        body_html: parsed.bodyHtml,
        s3_ref: {
          bucket: s3Action.bucketName,
          key: s3Action.objectKey,
          region: 'eu-west-1',
        },
        received_at: parsed.receivedAt,
      },
      received_at: new Date().toISOString(),
    });

    // PutEvents wrapped in withTimeoutAndRetry — Phase 4 D-24 contract.
    // 10s timeout, 2 retries, dead-letter on final failure. The dead-letter
    // pool is intentionally undefined here (no RDS access — this Lambda is
    // outside the VPC per D-05); failures fall back to the EventBridge
    // dead-letter detail emit, which the dashboard surfaces.
    await withTimeoutAndRetry(
      () =>
        eb.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: 'kos.capture',
                Source: 'kos.capture',
                DetailType: 'capture.received',
                Detail: JSON.stringify(detail),
              },
            ],
          }),
        ),
      {
        toolName: 'eventbridge:put-events:kos.capture',
        captureId,
        ownerId,
        eventBridge: eb,
        requestPreview: `email-forward ${parsed.messageId}`,
      },
    );

    results.push({ capture_id: captureId, message_id: parsed.messageId });
  }

  // Flush traces to Langfuse before Lambda returns; bounded internally to 2s
  // so a Langfuse outage cannot extend cold-path latency.
  await langfuseFlush();

  return { processed: results.length, records: results };
});
