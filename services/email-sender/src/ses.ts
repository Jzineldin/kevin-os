/**
 * email-sender SES helpers — buildRawMessage + sendRawEmail.
 *
 * Per Plan 04-05 §interfaces. Phase 4 D-23: SES SendRawEmail (NOT SendEmail)
 * so we can attach In-Reply-To / References headers that thread replies
 * onto the original inbound email; SendEmail's structured API doesn't
 * expose those headers.
 *
 * `buildRawMessage` synthesises a minimal RFC 5322 MIME body. Plain-text
 * only by default; multipart/alternative when `bodyHtml` is provided.
 * Headers we set (in order):
 *
 *   From:          (caller-supplied; must be a verified SES identity)
 *   To:            comma-joined list
 *   Cc:            optional; comma-joined
 *   Subject:       UTF-8 verbatim — Phase 4's drafts are SE/EN; SES handles it
 *   Date:          UTC RFC 2822 (`new Date().toUTCString()`)
 *   Message-ID:    `<<epoch>.<rand>@kos.tale-forge.app>` so inbound replies
 *                  can thread onto our outbound id
 *   MIME-Version:  1.0
 *   In-Reply-To:   optional; original Message-ID for threading
 *   References:    optional; previous Message-ID chain (space-joined)
 *   Content-Type:  text/plain; charset=utf-8  OR
 *                  multipart/alternative; boundary="..."
 *
 * Body is CRLF-joined per RFC 5322. The boundary is fresh per call so
 * repeated sends never collide on the wire.
 *
 * `sendRawEmail` calls SES SendRawEmailCommand with the body as UTF-8
 * bytes. SES allocates its own envelope Message-ID (returned via the
 * MessageId field); we stamp THAT id into email_drafts.sent_message_id so
 * the audit trail matches what AWS actually delivered. The Message-ID
 * header we synthesised above lives only in the body and is what inbound
 * threading clients will see.
 */
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

export interface RawMessageInput {
  from: string;
  to: string[];
  cc?: string[];
  /** RFC 5322 Message-ID of the email being replied to. */
  inReplyTo?: string;
  /** Previous Message-ID chain (each value already wrapped in <>). */
  references?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}

let sesClient: SESClient | null = null;

function getSes(): SESClient {
  if (sesClient) return sesClient;
  sesClient = new SESClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
  return sesClient;
}

/** Test seam — let unit tests inject a mocked SES client. */
export function __setSesClientForTest(fake: SESClient | null): void {
  sesClient = fake;
}

/**
 * Synthesise an RFC 5322 message ready for SES SendRawEmail.
 *
 * Pure / deterministic except for `Date` + `Message-ID` + boundary string.
 * Tests assert structural shape (header presence + CRLF separation +
 * body parts) rather than exact bytes.
 */
export function buildRawMessage(i: RawMessageInput): string {
  const boundary = 'KOS-BOUNDARY-' + Math.random().toString(36).slice(2);
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@kos.tale-forge.app>`;
  const headers: string[] = [
    `From: ${i.from}`,
    `To: ${i.to.join(', ')}`,
  ];
  if (i.cc && i.cc.length > 0) {
    headers.push(`Cc: ${i.cc.join(', ')}`);
  }
  headers.push(`Subject: ${i.subject}`);
  headers.push(`Date: ${date}`);
  headers.push(`Message-ID: ${messageId}`);
  headers.push('MIME-Version: 1.0');
  if (i.inReplyTo) headers.push(`In-Reply-To: ${i.inReplyTo}`);
  if (i.references && i.references.length > 0) {
    headers.push(`References: ${i.references.join(' ')}`);
  }

  let body: string;
  if (i.bodyHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      i.bodyText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      i.bodyHtml,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    headers.push('Content-Transfer-Encoding: 8bit');
    body = i.bodyText;
  }
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

/**
 * Send a raw RFC 5322 message via SES.
 *
 * Returns the SES envelope MessageId. The caller stamps this into
 * email_drafts.sent_message_id for audit. Errors surface untouched —
 * `withTimeoutAndRetry` in the handler classifies + retries them.
 */
export async function sendRawEmail(raw: string): Promise<{ messageId: string }> {
  const r = await getSes().send(
    new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw, 'utf8') } }),
  );
  return { messageId: r.MessageId ?? '' };
}
