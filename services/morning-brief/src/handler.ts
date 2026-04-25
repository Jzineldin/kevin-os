// Phase 7 Plan 07-00 scaffold. Real body in Plan 07-01 (morning-brief).
// AUTO-01 — fires Mon-Fri 08:00 Stockholm; loads context, calls Sonnet 4.6 via
// tool_use (MorningBriefSchema), writes Notion 🏠 Today + Daily Brief Log,
// emits a single output.push to kos.output (counts 1-of-3 daily cap).
if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

export async function handler(_event: unknown): Promise<{ skipped: 'scaffold'; service: string }> {
  return { skipped: 'scaffold', service: 'morning-brief' };
}
