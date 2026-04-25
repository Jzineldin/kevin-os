/**
 * @kos/service-ses-inbound — CAP-03 (forward@kos.tale-forge.app inbound mail).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (S3 GetObject for the SES-stored MIME, mailparser parse, EventBridge emit
 * of `capture.received` with `channel='email-forward'`) lands in Plan 04-02.
 *
 * SES delivers inbound mail to S3; the bucket policy already restricts
 * PutObject to ses.amazonaws.com with a SourceAccount condition. This Lambda
 * is a downstream S3:ObjectCreated subscriber.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service ses-inbound: handler body not yet implemented — see Plan 04-02',
  );
};
