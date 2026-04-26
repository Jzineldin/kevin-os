// services/mutation-executor/src/handler.ts (stub — body arrives in Plan 08-04)
//
// Phase 8 AGT-08 archive-not-delete executor: consumes
// pending_mutation.approved events on kos.output, performs the bounded
// archive operation per mutation_type — never deletes data, only flips
// status fields and stamps audit timestamps. Emits pending_mutation.executed
// once done. Reversibility per CLAUDE.md is preserved: a future "unarchive"
// pathway can flip the same fields back.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service mutation-executor: handler body not yet implemented — see Plan 08-04',
  );
};
