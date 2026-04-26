/**
 * MIME parser for raw RFC 5322 email payloads delivered by SES inbound to S3
 * (CAP-03 — Plan 04-02).
 *
 * Uses `mailparser` v3.x — the most battle-tested Node MIME parser; handles
 * Outlook RFC-5322-ish + Gmail forwarded-headers-in-body case +
 * multipart/alternative / multipart/mixed / quoted-printable / base64 transfer
 * encodings transparently. We do NOT reinvent any of this.
 *
 * Defensive parsing notes (T-04-SES-05 mitigation): everything below is
 * attacker-controlled content. We:
 *   - Reject empty/zero-length buffers eagerly with an actionable error
 *     (the caller surfaces this via Sentry; SES inbound does not retry on
 *     successful Lambda invocation, so an empty buffer = corrupted upload).
 *   - Strip angle brackets from Message-ID per RFC 5322 §3.6.4 (`msg-id` is
 *     `<id-left "@" id-right>`); downstream idempotency joins on the bare
 *     identifier so a missing-vs-present `<>` MUST NOT produce two captures.
 *   - Require Message-ID — without it we cannot derive the deterministic
 *     capture_id, and SES can/will retry the same S3 object (we'd lose the
 *     idempotency guarantee). Throwing here surfaces in the dead-letter
 *     path; better than silently dropping the email.
 *   - Coerce the address arrays defensively: mailparser's typing is a union
 *     of `AddressObject` / `AddressObject[]` / `string`, and partially-parsed
 *     headers can produce undefined fields. We always return arrays even if
 *     empty so consumers can iterate without optional-chaining boilerplate.
 *   - Body fields default to '' / undefined rather than null so the Zod
 *     schema in @kos/contracts (CaptureReceivedEmailForwardSchema) parses
 *     cleanly; `bodyHtml` is only set when mailparser produced a non-false
 *     string (false means no HTML alternative was present).
 */
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';

/** Normalised, schema-aligned shape consumed by the SES inbound handler. */
export interface ParsedEmail {
  /** RFC 5322 Message-ID with surrounding `<>` stripped. Required (we throw if absent). */
  messageId: string;
  /** First From address, or the raw header text if no structured address parsed. */
  from: string;
  /** Every parsed To address. May be empty if SES delivered without a To header. */
  to: string[];
  /** Every parsed Cc address. Undefined when no Cc header was present (NOT empty array). */
  cc?: string[];
  /** Subject string. Defaults to '' when missing — schema requires the key. */
  subject: string;
  /** text/plain body (or empty string). mailparser flattens nested multipart/alternative. */
  bodyText: string;
  /** text/html body when present. Undefined if the email is plain-text only. */
  bodyHtml?: string;
  /** ISO timestamp from the Date header, or now() if the header is missing/malformed. */
  receivedAt: string;
}

/** Normalise mailparser's address union into a clean string[] (never undefined). */
function addressesFromField(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  // simpleParser returns AddressObject for single header, AddressObject[] only
  // when the source had multiple comma-separated fields concatenated by RFC
  // 5322 (rare — usually it folds into a single AddressObject with .value[]).
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const obj of objs) {
    if (!obj.value) continue;
    for (const addr of obj.value) {
      if (addr.address) out.push(addr.address);
    }
  }
  return out;
}

/**
 * Parse a raw RFC 5322 MIME buffer (the payload SES wrote to S3) into the
 * normalised `ParsedEmail` envelope.
 *
 * @throws when the input buffer is empty (corrupted upload — caller decides
 *   whether to dead-letter or surface).
 * @throws when the Message-ID header is missing — without it we can't derive
 *   the deterministic capture_id, and a retry would produce a different ULID.
 */
export async function parseRawEmail(rfc822: Buffer): Promise<ParsedEmail> {
  if (!rfc822 || rfc822.length === 0) {
    throw new Error('parseRawEmail: empty MIME buffer (possible S3 upload corruption)');
  }

  const parsed = await simpleParser(rfc822);

  // Strip the surrounding `<id@host>` brackets per RFC 5322 §3.6.4.
  // Defensive: mailparser sometimes returns the value with brackets, sometimes
  // without, depending on header source (Outlook vs Gmail vs raw injection).
  const rawId = (parsed.messageId ?? '').trim();
  const messageId = rawId.replace(/^<+|>+$/g, '').trim();
  if (!messageId) {
    throw new Error('parseRawEmail: missing Message-ID header (cannot derive capture_id)');
  }

  // mailparser collapses `from` into a single AddressObject with .value[].
  // We prefer the parsed structural address; fall back to the raw text so a
  // malformed From still produces a non-empty string for the schema.
  const fromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
  const fromAddr =
    fromObj?.value?.[0]?.address ??
    fromObj?.text ??
    '';

  const to = addressesFromField(parsed.to);
  const ccArr = addressesFromField(parsed.cc);
  const cc = ccArr.length > 0 ? ccArr : undefined;

  const subject = parsed.subject ?? '';
  const bodyText = parsed.text ?? '';
  // mailparser sets `html` to `false` when no HTML alternative is present
  // and to a string when there is one. We map both `false` and undefined to
  // undefined so the optional schema field is omitted cleanly.
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : undefined;

  // Date header: prefer the parsed Date; fall back to now() when missing or
  // unparseable. Both branches yield an ISO 8601 string (Zod .datetime()).
  const receivedAt =
    parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
      ? parsed.date.toISOString()
      : new Date().toISOString();

  return { messageId, from: fromAddr, to, cc, subject, bodyText, bodyHtml, receivedAt };
}
