/**
 * Merge route SKELETONS — full transactional logic lands in Plan 03-08.
 *
 * Registering the routes here in Plan 03-02 means:
 *   • the 10-route count in the routing table (RESEARCH §7) is satisfied;
 *   • the Vercel-side API proxy (Plan 05) can build typed clients against
 *     the full surface without waiting for Plan 08;
 *   • Plan 08 only needs to replace the handler bodies — the routes are
 *     already registered and IAM-reachable.
 *
 * Archive-never-delete (STATE.md #12) WILL be enforced here in Plan 08 —
 * the handler MUST call `notion.pages.update({ archived: true })` and
 * never `notion.pages.delete`. A grep assertion already exists in
 * tests/merge-transactional.test.ts scaffolded in Plan 00.
 */
import { register, type Ctx, type RouteResponse } from '../router.js';

async function mergeExecute(_ctx: Ctx): Promise<RouteResponse> {
  return {
    statusCode: 501,
    body: JSON.stringify({ error: 'implemented_in_plan_08', handler: 'merge.execute' }),
  };
}

async function mergeResume(_ctx: Ctx): Promise<RouteResponse> {
  return {
    statusCode: 501,
    body: JSON.stringify({ error: 'implemented_in_plan_08', handler: 'merge.resume' }),
  };
}

register('POST', '/entities/:id/merge', mergeExecute);
register('POST', '/entities/:id/merge/resume', mergeResume);

export { mergeExecute, mergeResume };
