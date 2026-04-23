/**
 * @kos/dashboard-notify — EventBridge rule target on kos.output bus.
 * Translates kos.output events into Postgres NOTIFY payloads (D-22/D-25).
 *
 * Wave 0 scaffold only — real NOTIFY publish lands in plan 03-06.
 */
import type { EventBridgeHandler } from 'aws-lambda';

export const handler: EventBridgeHandler<string, unknown, { received: string }> = async (
  event,
) => {
  return { received: event['detail-type'] };
};
