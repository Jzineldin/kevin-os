/**
 * @kos/service-emailengine-admin — operator-facing Lambda for EmailEngine
 * account registration + webhook configuration (CAP-07 ops surface).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (Function URL with AWS_IAM auth, native fetch to EmailEngine REST API
 * to register accounts + set the webhook secret) lands in Plan 04-03.
 *
 * Auth: Lambda Function URL with AWS_IAM. Operator invokes via
 * `aws lambda invoke-url` with SigV4 signing.
 */
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service emailengine-admin: handler body not yet implemented — see Plan 04-03',
  );
};
