// services/publisher/src/handler.ts (stub — body arrives in Plan 08-03)
//
// Phase 8 CAP-09 outbound publisher: consumes content.approved events on
// kos.output, fetches the matching authorization row, calls the Postiz MCP
// endpoint at postiz.kos.local:3000 to schedule the post, and stamps
// consumed_at + publish_result on content_publish_authorizations. Emits
// content.published on kos.output.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service publisher: handler body not yet implemented — see Plan 08-03',
  );
};
