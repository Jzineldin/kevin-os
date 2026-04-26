// services/content-writer/src/handler.ts (stub — body arrives in Plan 08-02)
//
// Phase 8 AGT-07 orchestrator: receives ContentTopicSubmitted events on the
// kos.capture bus, fans out per-platform draft work to content-writer-platform
// Lambdas via Step Functions, and persists draft skeletons to content_drafts.
//
// Hard fail in scaffold so an accidental deploy of the empty Lambda is
// surfaced immediately rather than silently 200-ing.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service content-writer: handler body not yet implemented — see Plan 08-02',
  );
};
