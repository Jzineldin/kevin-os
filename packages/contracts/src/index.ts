/**
 * @kos/contracts — barrel export.
 *
 * Re-exports event schemas (Phase 1/2), dashboard schemas (Phase 3), and
 * context schemas (Phase 6 AGT-04 + INF-10). Prefer scoped subpath imports:
 *   import { CaptureReceivedSchema } from '@kos/contracts/events';
 *   import { TodayResponseSchema } from '@kos/contracts/dashboard';
 *   import { ContextBundleSchema } from '@kos/contracts/context';
 */
export * from './events.js';
export * from './dashboard.js';
export * from './context.js';
