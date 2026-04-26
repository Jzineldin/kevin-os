/**
 * Phase 8 Plan 08-00 Task 5 — canned Postiz MCP JSON-RPC responses.
 *
 * publisher (Plan 08-03) calls Postiz at postiz.kos.local:3000/api/mcp/{KEY}
 * via Streamable HTTP. These fixtures cover the four user-visible response
 * shapes:
 *   1. create-post success (immediate or scheduled)
 *   2. delete-post success (used by mutation-executor's cancel_content_draft
 *      pathway when the draft was already published)
 *   3. rate-limited error (LinkedIn caps publishing during business hours)
 *   4. platform-not-authenticated error (Postiz integration was unlinked)
 *
 * Plus a list-integrations snapshot used by Plan 08-03 health checks.
 */
export const POSTIZ_CREATE_POST_SUCCESS = {
  jsonrpc: '2.0',
  id: '1',
  result: {
    post_id: 'pst_abc123',
    status: 'scheduled',
    schedule_time: '2026-04-25T14:00:00Z',
  },
};

export const POSTIZ_DELETE_POST_SUCCESS = {
  jsonrpc: '2.0',
  id: '2',
  result: {
    post_id: 'pst_abc123',
    status: 'cancelled',
  },
};

export const POSTIZ_RATE_LIMITED = {
  jsonrpc: '2.0',
  id: '3',
  error: {
    code: -32000,
    message: 'Rate limited by LinkedIn',
    data: { retry_after: 60 },
  },
};

export const POSTIZ_PLATFORM_NOT_AUTHED = {
  jsonrpc: '2.0',
  id: '4',
  error: {
    code: -32001,
    message: 'Instagram not authenticated — connect via Postiz UI',
  },
};

export const POSTIZ_LIST_INTEGRATIONS_FULL = {
  jsonrpc: '2.0',
  id: '5',
  result: {
    integrations: [
      { platform: 'instagram', connected: true },
      { platform: 'linkedin', connected: true },
      { platform: 'tiktok', connected: true },
      { platform: 'reddit', connected: true },
      { platform: 'newsletter', connected: true },
    ],
  },
};
