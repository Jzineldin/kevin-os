'use server';

/**
 * Today Server Actions — called from <Composer /> (and future Today-embedded
 * actions). Lives here (rather than in a shared /lib module) because the
 * 'use server' directive is route-scoped and Next 15 is stricter about
 * Server Actions crossing boundary files.
 *
 * See 03-RESEARCH §17 P-15 (useOptimistic + Server Action boundary).
 */
import { callApi } from '@/lib/dashboard-api';
import {
  CapturePostSchema,
  CaptureResponseSchema,
  type CaptureResponse,
} from '@kos/contracts/dashboard';

/**
 * captureText — POST /capture with a text payload. Returns the ack with
 * the fresh server-minted ULID capture_id and server-minted received_at.
 *
 * Throws on:
 *   - zod validation failure (client bug — fail loud, surface in toast)
 *   - non-2xx response from dashboard-api (upstream outage — caller toasts)
 */
export async function captureText(text: string): Promise<CaptureResponse> {
  const input = CapturePostSchema.parse({ text });
  return callApi(
    '/capture',
    { method: 'POST', body: JSON.stringify(input) },
    CaptureResponseSchema,
  );
}
