/**
 * @kos/contracts — barrel export.
 *
 * Re-exports event schemas (Phase 1/2) and dashboard schemas (Phase 3).
 * Prefer the scoped subpath imports where available:
 *   import { CaptureReceivedSchema } from '@kos/contracts/events';
 *   import { TodayResponseSchema } from '@kos/contracts/dashboard';
 */
export * from './events.js';
export * from './dashboard.js';
