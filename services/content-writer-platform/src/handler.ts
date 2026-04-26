// services/content-writer-platform/src/handler.ts (stub — body arrives in Plan 08-02)
//
// Phase 8 AGT-07 per-platform worker: invoked by Step Functions Map state
// (one execution per platform); produces a Bedrock Sonnet 4.6 draft tuned
// for one of {instagram, linkedin, tiktok, reddit, newsletter} using
// BRAND_VOICE.md + Kevin Context. Persists to content_drafts and emits
// draft.ready when the topic's last platform finishes.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service content-writer-platform: handler body not yet implemented — see Plan 08-02',
  );
};
