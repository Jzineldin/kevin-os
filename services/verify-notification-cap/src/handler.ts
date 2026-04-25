// Phase 7 Plan 07-00 scaffold. Real body in Plan 07-04 (verify-notification-cap).
// D-07 — runs every Sunday 03:00 Stockholm; reads DynamoDB TelegramCap +
// telegram_inbox_queue + denied_messages over 14 days; on violation emits
// kos.system / brief.compliance_violation (SNS → email).
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

export async function handler(_event: unknown): Promise<{ skipped: 'scaffold'; service: string }> {
  return { skipped: 'scaffold', service: 'verify-notification-cap' };
}
