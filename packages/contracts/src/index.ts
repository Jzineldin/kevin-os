/**
 * @kos/contracts — barrel export.
 *
 * Re-exports event schemas (Phase 1/2), dashboard schemas (Phase 3),
 * context schemas (Phase 6 AGT-04 + INF-10), brief schemas (Phase 7
 * AUTO-01/03/04), email schemas (Phase 4), and migration schemas
 * (Phase 10 MIG-01/02 + CAP-10 + INF-11). Prefer scoped subpath imports:
 *   import { CaptureReceivedSchema } from '@kos/contracts/events';
 *   import { TodayResponseSchema } from '@kos/contracts/dashboard';
 *   import { ContextBundleSchema } from '@kos/contracts/context';
 *   import { MorningBriefSchema } from '@kos/contracts/brief';
 *   import { ClassifyPayloadSchema } from '@kos/contracts/migration';
 */
export * from './events.js';
export * from './dashboard.js';
export * from './context.js';
export * from './brief.js';
export * from './email.js';
export * from './migration.js';
