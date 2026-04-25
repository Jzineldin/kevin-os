// Phase 7 Plan 07-00 scaffold. Real body in Plan 07-02 (weekly-review).
// AUTO-04 — fires Sunday 19:00 Stockholm; loads context over 7 days, calls
// Sonnet 4.6 via tool_use (WeeklyReviewSchema), overwrites Kevin Context
// "Active threads" section, appends Daily Brief Log, emits one output.push.
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

export async function handler(_event: unknown): Promise<{ skipped: 'scaffold'; service: string }> {
  return { skipped: 'scaffold', service: 'weekly-review' };
}
