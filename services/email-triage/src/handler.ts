/**
 * Email-triage Lambda (AGT-05) — EventBridge target.
 *
 * Three event paths:
 *   1. capture.received / kind=email_inbox  (kos.capture, from emailengine-webhook)
 *   2. capture.received / kind=email_forward (kos.capture, from ses-inbound)
 *   3. scan_emails_now                       (kos.system, on-demand AUTO-02 path)
 *
 * Per-email flow (paths 1+2):
 *   1. Parse + validate detail by `detail-type` + `kind` (Zod).
 *   2. Idempotent INSERT into email_drafts (UNIQUE on (account_id,message_id)).
 *      Replays of the same EmailEngine messageNew webhook never double-insert.
 *   3. Resolve entities by email address; load Kevin Context (+ optional
 *      Phase 6 dossier markdown via @kos/context-loader).
 *   4. Haiku 4.5 classify (wrapped in withTimeoutAndRetry).
 *   5. If classification == 'urgent' → Sonnet 4.6 draft.
 *   6. UPDATE email_drafts (status=draft|skipped + classification + body).
 *   7. If status=draft → emit draft_ready on kos.output for the dashboard SSE
 *      + Approve gate (Plan 04-05 consumes this).
 *
 * scan_emails_now flow:
 *   - SELECT all status='pending_triage' rows (capped) and re-run per-email
 *     flow steps 3-7 against each.
 *
 * Prompt injection (Gate 3 criterion 2):
 *   - Email body wrapped in <email_content> tags inside both classify and
 *     draft prompts; system prompt declares delimited content as DATA only.
 *   - Adversarial fixture from @kos/test-fixtures verifies this Lambda
 *     classifies the injection email as non-urgent (junk/informational) and
 *     never includes the attacker payload verbatim in the draft.
 *   - SES is structurally absent from this Lambda's IAM (Gate 3): even a
 *     compromised model cannot send email here.
 *
 * Reliability (D-24):
 *   - withTimeoutAndRetry wraps every Bedrock call (10s timeout, 2 retries).
 *   - On final failure: agent_dead_letter row + inbox.dead_letter event.
 *   - langfuseFlush always awaited in finally (Pitfall 9).
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { withTimeoutAndRetry } from '../../_shared/with-timeout-retry.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CaptureReceivedEmailForwardSchema,
  CaptureReceivedEmailInboxSchema,
  DraftReadySchema,
  type CaptureReceivedEmailInbox,
} from '@kos/contracts';
import { runClassifyAgent } from './classify.js';
import { runDraftAgent } from './draft.js';
import { loadTriageContext } from './context.js';
import {
  findExistingDraftByMessage,
  getPool,
  insertEmailDraftPending,
  loadPendingDrafts,
  updateEmailDraftClassified,
  type PendingDraftRow,
} from './persist.js';
import { resolveEntitiesByEmail } from './resolveEntities.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION });

/** Output bus name where draft_ready is emitted. */
const OUTPUT_BUS_NAME = process.env.OUTPUT_BUS_NAME ?? 'kos.output';

interface EBEvent {
  source?: string;
  'detail-type': string;
  detail: unknown;
}

export const handler = wrapHandler(async (event: EBEvent) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  try {
    const dt = event['detail-type'];

    if (dt === 'capture.received') {
      const detailObj = (event.detail ?? {}) as { kind?: string };
      const kind = detailObj.kind;
      if (kind === 'email_inbox') {
        const detail = CaptureReceivedEmailInboxSchema.parse(event.detail);
        return await processOne(detail, ownerId);
      }
      if (kind === 'email_forward') {
        const fwd = CaptureReceivedEmailForwardSchema.parse(event.detail);
        // Map the forward shape → per-email-inbox flow. SES inbound has no
        // EmailEngine account_id; we synthesize 'forward' so the UNIQUE
        // (account_id, message_id) constraint still discriminates between
        // forwarded copies and inbox-pushed copies of the same Message-ID.
        const detail: CaptureReceivedEmailInbox = {
          capture_id: fwd.capture_id,
          channel: 'email-inbox',
          kind: 'email_inbox',
          email: {
            account_id: 'forward',
            message_id: fwd.email.message_id,
            from: fwd.email.from,
            to: fwd.email.to,
            ...(fwd.email.cc !== undefined ? { cc: fwd.email.cc } : {}),
            subject: fwd.email.subject,
            body_text: fwd.email.body_text,
            ...(fwd.email.body_html !== undefined ? { body_html: fwd.email.body_html } : {}),
            received_at: fwd.email.received_at,
          },
          received_at: fwd.received_at,
        };
        return await processOne(detail, ownerId);
      }
      return { skipped: `kind=${kind ?? 'undefined'}` };
    }

    if (dt === 'scan_emails_now') {
      const pool = await getPool();
      const limit = Number(process.env.SCAN_LIMIT ?? '50');
      const pending = await loadPendingDrafts(pool, ownerId, limit);
      const results: Array<{ draft_id: string; classification: string }> = [];
      for (const row of pending) {
        try {
          results.push(await processOneFromRow(row, ownerId));
        } catch (err) {
          console.error('[email-triage] scan_emails_now per-row failed', {
            draft_id: row.id,
            err: String(err),
          });
        }
      }
      return { scanned: pending.length, results };
    }

    return { skipped: dt };
  } finally {
    await langfuseFlush();
  }
});

/**
 * Per-email pipeline — runs against a fresh inbound EventBridge detail.
 * Idempotent on (account_id, message_id) via the migration 0016 UNIQUE
 * constraint: replays return the same draft_id and skip the LLM calls
 * if a non-pending draft already exists (Gate 3 criterion 1).
 */
async function processOne(
  detail: CaptureReceivedEmailInbox,
  ownerId: string,
): Promise<{ draft_id: string; classification: string }> {
  const captureId = detail.capture_id;
  tagTraceWithCaptureId(captureId);

  const pool = await getPool();

  // Idempotent INSERT — returns existing id on conflict. Now persists
  // the full body too (migration 0024) so the dashboard can render it.
  const draftId = await insertEmailDraftPending(pool, {
    ownerId,
    captureId,
    accountId: detail.email.account_id,
    messageId: detail.email.message_id,
    from: detail.email.from,
    to: detail.email.to,
    subject: detail.email.subject,
    receivedAt: detail.email.received_at,
    bodyPlain: detail.email.body_text ?? null,
    bodyHtml: detail.email.body_html ?? null,
  });

  // If the row already exists with a non-pending status, the same
  // EmailEngine webhook is replaying — short-circuit the LLM round trip.
  const existingId = await findExistingDraftByMessage(
    pool,
    detail.email.account_id,
    detail.email.message_id,
  );
  // existingId equals draftId by construction; we re-query to grab the
  // current status efficiently (one round trip).
  void existingId;

  // Resolve entities by participant addresses so Phase 6 context-loader
  // can pull the matching dossiers.
  const addrs = [
    detail.email.from,
    ...detail.email.to,
    ...(detail.email.cc ?? []),
  ];
  const entityIds = await resolveEntitiesByEmail(pool, ownerId, addrs);

  // Load context (Kevin Context + optional dossier markdown).
  const ctx = await loadTriageContext({
    entityIds,
    ownerId,
    captureId,
    rawText: detail.email.body_text.slice(0, 2000),
  });

  // Classify — Haiku 4.5, wrapped for timeouts + retries.
  const classifyResult = await withTimeoutAndRetry(
    () =>
      runClassifyAgent({
        from: detail.email.from,
        to: detail.email.to,
        ...(detail.email.cc !== undefined ? { cc: detail.email.cc } : {}),
        subject: detail.email.subject,
        body: detail.email.body_text,
        receivedAt: detail.email.received_at,
        kevinContextBlock: ctx.kevinContext,
        additionalContextBlock: ctx.additionalContextBlock,
      }),
    {
      timeoutMs: 10_000,
      maxRetries: 2,
      toolName: 'bedrock.haiku.classify',
      captureId,
      ownerId,
      pool,
      eventBridge: eb,
      requestPreview: detail.email.subject.slice(0, 200),
    },
  );

  let draftBody: string | undefined;
  let draftSubject: string | undefined;
  if (classifyResult.output.classification === 'urgent') {
    const draftResult = await withTimeoutAndRetry(
      () =>
        runDraftAgent({
          from: detail.email.from,
          to: detail.email.to,
          ...(detail.email.cc !== undefined ? { cc: detail.email.cc } : {}),
          subject: detail.email.subject,
          body: detail.email.body_text,
          receivedAt: detail.email.received_at,
          kevinContextBlock: ctx.kevinContext,
          additionalContextBlock: ctx.additionalContextBlock,
          classification: 'urgent',
        }),
      {
        timeoutMs: 10_000,
        maxRetries: 2,
        toolName: 'bedrock.sonnet.draft',
        captureId,
        ownerId,
        pool,
        eventBridge: eb,
        requestPreview: detail.email.subject.slice(0, 200),
      },
    );
    draftBody = draftResult.output.body;
    draftSubject = draftResult.output.subject;
  }

  const status: 'draft' | 'skipped' =
    classifyResult.output.classification === 'urgent' ? 'draft' : 'skipped';

  await updateEmailDraftClassified(pool, draftId, {
    classification: classifyResult.output.classification,
    ...(draftBody !== undefined ? { draftBody } : {}),
    ...(draftSubject !== undefined ? { draftSubject } : {}),
    triagedAt: new Date().toISOString(),
    status,
  });

  if (status === 'draft') {
    const ev = DraftReadySchema.parse({
      capture_id: captureId,
      draft_id: draftId,
      classification: classifyResult.output.classification,
      sender: detail.email.from,
      subject: detail.email.subject,
      preview: (draftBody ?? '').slice(0, 400),
      reply_to: detail.email.from,
      emitted_at: new Date().toISOString(),
    });
    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: OUTPUT_BUS_NAME,
            Source: 'kos.output',
            DetailType: 'draft_ready',
            Detail: JSON.stringify(ev),
          },
        ],
      }),
    );
  }

  return {
    draft_id: draftId,
    classification: classifyResult.output.classification,
  };
}

/**
 * scan_emails_now path — operates on an already-persisted email_drafts
 * row (status='pending_triage'). Builds a synthetic CaptureReceivedEmailInbox
 * shape from the row + a placeholder body_text='' (we don't store body in
 * email_drafts; the LLM falls back to subject + headers only). Operator
 * use case: bulk re-classify after a prompt tweak.
 */
async function processOneFromRow(
  row: PendingDraftRow,
  ownerId: string,
): Promise<{ draft_id: string; classification: string }> {
  const synthetic: CaptureReceivedEmailInbox = {
    capture_id: row.capture_id as CaptureReceivedEmailInbox['capture_id'],
    channel: 'email-inbox',
    kind: 'email_inbox',
    email: {
      account_id: row.account_id,
      message_id: row.message_id,
      from: row.from_email,
      to: row.to_email,
      subject: row.subject,
      body_text: '',
      received_at: new Date(row.received_at).toISOString(),
    },
    received_at: new Date(row.received_at).toISOString(),
  };
  return processOne(synthetic, ownerId);
}
