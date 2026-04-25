/**
 * @kos/service-email-sender — AGT-05 send leg (post-Approve).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (EventBridge target on `kos.output` / `email.approved`, consume the
 * email_send_authorizations row, ses:SendRawEmail, mark draft sent)
 * lands in Plan 04-05.
 *
 * Structural separation per Phase 4 D-04: this Lambda has NO
 * `@anthropic-ai/*` dependency — it is a pure SES dispatcher gated on a
 * matching Approve token in `email_send_authorizations`.
 */
import { EmailApprovedSchema } from '@kos/contracts';

void EmailApprovedSchema;

export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service email-sender: handler body not yet implemented — see Plan 04-05',
  );
};
