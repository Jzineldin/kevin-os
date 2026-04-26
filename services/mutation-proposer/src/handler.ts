// services/mutation-proposer/src/handler.ts (stub — body arrives in Plan 08-04)
//
// Phase 8 AGT-08 imperative-verb proposer: regex-prescreens capture text
// (Swedish + English), Haiku 4.5 confirms intent, Sonnet 4.6 resolves the
// target ref to one of {meeting, task, content_draft, email_draft, document}.
// Writes pending_mutations rows; emits pending_mutation.proposed for the
// dashboard Approve gate. NEVER mutates Notion / DB rows directly.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service mutation-proposer: handler body not yet implemented — see Plan 08-04',
  );
};
