/**
 * @kos/contracts — Phase 10 migration & decommission schemas.
 *
 * Wave 0 (Plan 10-00) lays the contracts so:
 *   - Plan 10-01 (vps-classify-migration) can import `ClassifyPayloadSchema`
 *     + `ClassifyAdapterResultSchema` directly,
 *   - Plan 10-02 (n8n archive) reuses the audit row helpers,
 *   - Plan 10-03..10-05 (Brain DB archive, VPS freeze + power-down,
 *     Hetzner snapshot ops) emit `event_log` rows whose `kind` is
 *     constrained by `EventLogKindSchema`,
 *   - Plan 10-04 (Discord poller) Zod-parses incoming Discord REST
 *     responses with `DiscordChannelMessageSchema`,
 *   - Plan 10-06 (operator inventory snapshot) parses
 *     `VpsServiceInventorySchema` from the freeze-script export.
 *
 * The Zod surface is intentionally permissive on the VPS classify payload
 * (`.passthrough()`) — the VPS-side `classify_and_save.py` script accepts
 * arbitrary keyword arguments and the adapter's job is to relay them
 * verbatim to `kos.capture / capture.received`, NOT to police the schema.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// MIG-01 — VPS classify_and_save adapter (services/vps-classify-migration)
// ---------------------------------------------------------------------------

/**
 * Inbound payload from the VPS-side `classify_and_save.py` HMAC-signed
 * webhook. The VPS script accepts arbitrary keyword args and the adapter
 * is the bridge during cutover; passthrough so we never reject a payload
 * just because the VPS shipped a new field.
 */
export const ClassifyPayloadSchema = z
  .object({
    title: z.string().optional(),
    subject: z.string().optional(),
    is_duplicate: z.boolean().optional(),
    already_processed: z.boolean().optional(),
  })
  .passthrough();
export type ClassifyPayload = z.infer<typeof ClassifyPayloadSchema>;

/**
 * Adapter's response shape — returned to the VPS caller AND captured
 * (capture_id) for audit reconciliation against the legacy Notion Inbox.
 */
export const ClassifyAdapterResultSchema = z.object({
  capture_id: z.string().min(26).max(26), // ULID — 26 char Crockford base32
  emitted_at: z.string().datetime({ offset: true }),
  source: z.literal('vps-classify-migration-adapter'),
});
export type ClassifyAdapterResult = z.infer<typeof ClassifyAdapterResultSchema>;

// ---------------------------------------------------------------------------
// CAP-10 — Discord brain-dump poller (services/discord-brain-dump)
// ---------------------------------------------------------------------------

/**
 * Subset of the Discord REST `GET /channels/{id}/messages` element the
 * poller needs. We do not pin the full discord-api-types shape here —
 * keeping this Zod-narrow guards against Discord adding fields we don't
 * care about, while still rejecting wholesale shape changes.
 */
export const DiscordChannelMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  author: z.object({
    id: z.string(),
    username: z.string(),
    bot: z.boolean().optional(),
  }),
  content: z.string(),
  timestamp: z.string().datetime({ offset: true }),
});
export type DiscordChannelMessage = z.infer<typeof DiscordChannelMessageSchema>;

// ---------------------------------------------------------------------------
// INF-11 — VPS service inventory snapshot
// ---------------------------------------------------------------------------

export const VpsServiceEntrySchema = z.object({
  unit_name: z.string(),
  unit_type: z.enum(['python-script', 'systemd-timer', 'n8n-daemon', 'generic-daemon']),
  state: z.enum(['active', 'inactive', 'failed', 'unknown']),
  /** ULID/ARN/Lambda-name of the migrated successor; null while still on VPS. */
  replaced_by: z.string().nullable(),
});
export type VpsServiceEntry = z.infer<typeof VpsServiceEntrySchema>;

export const VpsServiceInventorySchema = z.object({
  discovered_at: z.string().datetime({ offset: true }),
  host: z.string(),
  services: z.array(VpsServiceEntrySchema),
});
export type VpsServiceInventory = z.infer<typeof VpsServiceInventorySchema>;

// ---------------------------------------------------------------------------
// Audit log — every Phase-10 plan writes to event_log via this kind enum
// ---------------------------------------------------------------------------

/**
 * Phase-10 audit kinds. The DB column is open-text (the COMMENT on
 * `event_log.kind` in migration 0021 documents the contract); enforcement
 * is at the application layer via this Zod enum so future kinds can land
 * without an ALTER TABLE.
 */
export const EventLogKindSchema = z.enum([
  'brain-db-archived',
  'vps-service-stopped',
  'vps-service-disabled',
  'vps-powered-down',
  'hetzner-snapshot-taken',
  'hetzner-snapshot-deleted',
  'n8n-workflows-archived',
  'n8n-stopped',
  'discord-listener-cutover',
  'classify-adapter-cutover',
  'telegram-webhook-retest',
]);
export type EventLogKind = z.infer<typeof EventLogKindSchema>;

/**
 * Shape of one row in the `event_log` table. Mirrors the existing Drizzle
 * schema (id, owner_id, kind, detail, occurred_at) plus the Phase-10
 * `actor` column added in migration 0021. Use ISO strings on the JSON
 * boundary; the DB stores TIMESTAMPTZ.
 *
 * NOTE: column is `detail` (singular) + `occurred_at` (matches the schema
 * shipped in migration 0001). The plan's draft mentioned `details` / `at`
 * — the on-disk column names take precedence so application code stays
 * compatible with the existing 0001 + 0011 readers.
 */
export const EventLogRowSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string(),
  kind: EventLogKindSchema,
  detail: z.record(z.unknown()).nullable(),
  occurred_at: z.string().datetime({ offset: true }),
  actor: z.string(),
});
export type EventLogRow = z.infer<typeof EventLogRowSchema>;
