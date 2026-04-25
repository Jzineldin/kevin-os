/**
 * node-fetch shim for Node 22 Lambda runtime.
 *
 * grammY v1.42 hard-requires `node-fetch` via its shim.node.js. On Node 22
 * Lambda, `node-fetch@2.7.0` crashes with "Expected signal to be an instanceof
 * AbortSignal" because it doesn't support the standard Web AbortSignal.
 *
 * This shim re-exports Node 22's native fetch/Request/Response/Headers so
 * grammY uses the built-in implementation. Configured via esbuild `alias` in
 * integrations-telegram.ts.
 */
const _fetch = globalThis.fetch;
export default _fetch;
export const { Request, Response, Headers } = globalThis;
