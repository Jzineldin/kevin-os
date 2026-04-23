/**
 * POST /capture — generic voice/text capture ingress.
 *
 * Generates a fresh ULID, validates body, publishes to the `kos.capture`
 * EventBridge bus. The Phase 2 Triage Lambda picks up the event and
 * produces the ack (draft_ready / capture_ack) via the `kos.output` bus
 * back to the dashboard.
 */
import { ulid } from 'ulid';
import { CapturePostSchema, CaptureResponseSchema } from '@kos/contracts/dashboard';
import { register, type Ctx, type RouteResponse } from '../router.js';
import { publishCapture } from '../events.js';

async function captureHandler(ctx: Ctx): Promise<RouteResponse> {
  let parsed;
  try {
    parsed = CapturePostSchema.parse(JSON.parse(ctx.body ?? '{}'));
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'invalid_body', detail: (e as Error).message }),
    };
  }

  const capture_id = ulid();
  const received_at = new Date().toISOString();

  try {
    await publishCapture({
      capture_id,
      source: 'dashboard',
      received_at,
      ...parsed,
    });
  } catch (err) {
    console.error('[dashboard-api] capture publish failed', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'eventbridge_publish_failed' }),
    };
  }

  const payload = CaptureResponseSchema.parse({ capture_id, received_at });

  return {
    statusCode: 202,
    body: JSON.stringify(payload),
  };
}

register('POST', '/capture', captureHandler);

export { captureHandler };
