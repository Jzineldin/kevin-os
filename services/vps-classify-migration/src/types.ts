/**
 * @kos/service-vps-classify-migration — type re-exports.
 *
 * The runtime payload + adapter result types live in @kos/contracts/migration
 * so any downstream Lambda or test fixture can speak the same shape without
 * importing service-internal symbols.
 */
export type { ClassifyPayload, ClassifyAdapterResult } from '@kos/contracts';
