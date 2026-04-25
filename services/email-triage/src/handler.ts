/**
 * @kos/service-email-triage — AGT-05 (email triage + draft generation).
 *
 * Phase 4 Wave 0 SCAFFOLD: this is a stub. Production handler body
 * (EventBridge target on `kos.capture` / `capture.received` for the
 * `email-forward` + `email-inbox` channels, classify via Haiku 4.5,
 * draft via Sonnet 4.6, persist to email_drafts, emit `draft.ready`)
 * lands in Plan 04-04.
 *
 * Pulls in `@kos/context-loader` for entity dossiers; if the package
 * fails to import at runtime (D-19 degraded operation), Plan 04-04 will
 * fall back to the legacy Kevin-Context-only block.
 */
import {
  CaptureReceivedEmailForwardSchema,
  CaptureReceivedEmailInboxSchema,
} from '@kos/contracts';

// Touch the schemas so unused-import lint stays quiet while body is missing.
void CaptureReceivedEmailForwardSchema;
void CaptureReceivedEmailInboxSchema;

export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 4 service email-triage: handler body not yet implemented — see Plan 04-04',
  );
};
