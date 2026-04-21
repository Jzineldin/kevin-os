import { z } from 'zod';

// EventBridge detail shapes. Populated incrementally — Phase 1 creates the file + barrel.
// Phase 2 adds CaptureReceivedEventDetail, NotionWriteConfirmedEventDetail, etc.
// The five bus names are load-bearing across 10 phases — do not rename.
export const BUS_NAMES = {
  CAPTURE: 'kos.capture',
  TRIAGE: 'kos.triage',
  AGENT: 'kos.agent',
  OUTPUT: 'kos.output',
  SYSTEM: 'kos.system',
} as const;
export type BusName = (typeof BUS_NAMES)[keyof typeof BUS_NAMES];

export const EventMetadataSchema = z.object({
  captureId: z.string().ulid(),
  ownerId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});
export type EventMetadata = z.infer<typeof EventMetadataSchema>;
