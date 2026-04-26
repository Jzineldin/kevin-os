// services/document-diff/src/handler.ts (stub — body arrives in Plan 08-05)
//
// Phase 8 MEM-05 document version tracker: triggered when a new email
// attachment arrives (via SES inbound or EmailEngine push). Extracts text
// (pdf-parse for PDFs, mammoth for docx, raw for txt/md), computes sha256,
// looks up prior versions for the same (recipient_email, doc_name), runs
// Haiku 4.5 to summarise the diff vs the previous version, persists to
// document_versions, emits document.version_created.
export const handler = async (_event: unknown): Promise<unknown> => {
  throw new Error(
    'Phase 8 service document-diff: handler body not yet implemented — see Plan 08-05',
  );
};
