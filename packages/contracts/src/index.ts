/**
 * @kos/contracts — barrel export.
 *
 * Re-exports event schemas (Phase 1/2), dashboard schemas (Phase 3),
 * context schemas (Phase 6 AGT-04 + INF-10), and brief schemas (Phase 7
 * AUTO-01/03/04). Prefer scoped subpath imports:
 *   import { CaptureReceivedSchema } from '@kos/contracts/events';
 *   import { TodayResponseSchema } from '@kos/contracts/dashboard';
 *   import { ContextBundleSchema } from '@kos/contracts/context';
 *   import { MorningBriefSchema } from '@kos/contracts/brief';
 */
export * from './events.js';
export * from './dashboard.js';
export * from './context.js';
export * from './brief.js';
export * from './email.js';
