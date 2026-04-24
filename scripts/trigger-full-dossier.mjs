#!/usr/bin/env node
/**
 * trigger-full-dossier.mjs — operator runbook trigger for Phase 6 INF-10.
 *
 * Emits a `context.full_dossier_requested` event on `kos.agent` so the
 * dossier-loader Lambda picks it up, calls Vertex Gemini 2.5 Pro
 * (europe-west4), and writes the comprehensive dossier into
 * `entity_dossiers_cached.dossier_markdown` with a `gemini-full:` prefix.
 *
 * Usage:
 *   node scripts/trigger-full-dossier.mjs \
 *     --entity-id 11111111-1111-1111-1111-111111111111 \
 *     [--owner-id ...] \
 *     [--intent "Load Damien full dossier before Almi reply"] \
 *     [--bus kos.agent]
 *
 * Multiple entity-id flags are accepted to batch a single dossier load.
 * Reads `KEVIN_OWNER_ID` from env when --owner-id is omitted.
 *
 * Reference: .planning/phases/06-granola-semantic-memory/06-05-PLAN.md
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';

// Lightweight ULID-ish id (Crockford-base32 26 chars). The operator path
// does not need monotonicity guarantees — the dossier-loader handler
// validates the schema's loose-form capture_id (string), and downstream
// observability uses our randomUUID() as a fallback if ULID parsing fails.
function ulid() {
  const time = Date.now().toString(32).toUpperCase().padStart(10, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
  return (time + rand).slice(0, 26);
}

function parseArgs(argv) {
  const out = { entityIds: [], intent: null, bus: 'kos.agent', ownerId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--entity-id') {
      const v = argv[i + 1];
      if (!v) throw new Error('--entity-id requires a value');
      out.entityIds.push(v);
      i += 1;
    } else if (a === '--intent') {
      out.intent = argv[i + 1];
      i += 1;
    } else if (a === '--bus') {
      out.bus = argv[i + 1];
      i += 1;
    } else if (a === '--owner-id') {
      out.ownerId = argv[i + 1];
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/trigger-full-dossier.mjs --entity-id <uuid> [--entity-id <uuid> ...] [--owner-id <uuid>] [--intent "..."] [--bus kos.agent]',
      );
      process.exit(0);
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.entityIds.length === 0) {
    console.error('ERROR: --entity-id is required (at least one).');
    process.exit(2);
  }
  for (const id of args.entityIds) {
    if (!UUID_RE.test(id)) {
      console.error(`ERROR: --entity-id "${id}" is not a valid UUID.`);
      process.exit(2);
    }
  }

  const ownerId = args.ownerId ?? process.env.KEVIN_OWNER_ID;
  if (!ownerId) {
    console.error('ERROR: --owner-id missing and KEVIN_OWNER_ID env var unset.');
    process.exit(2);
  }
  if (!UUID_RE.test(ownerId)) {
    console.error(`ERROR: owner-id "${ownerId}" is not a valid UUID.`);
    process.exit(2);
  }

  const captureId = ulid();
  const detail = {
    capture_id: captureId,
    owner_id: ownerId,
    entity_ids: args.entityIds,
    requested_by: 'operator',
    intent: args.intent ?? 'Operator-triggered full dossier load',
    requested_at: new Date().toISOString(),
  };

  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const eb = new EventBridgeClient({ region });
  const result = await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: args.bus,
          Source: 'kos.agent',
          DetailType: 'context.full_dossier_requested',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );

  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    console.error('PutEvents reported failures:', JSON.stringify(result.Entries, null, 2));
    process.exit(1);
  }

  console.log(
    `Emitted context.full_dossier_requested capture_id=${captureId} entity_ids=${args.entityIds.length}`,
  );
  console.log(
    `Tail CloudWatch /aws/lambda/<DossierLoader> for the gemini-full output (~30-90s typical).`,
  );
  console.log(
    `Verify the cache row: psql -c "SELECT entity_id, last_touch_hash, length(bundle::text) FROM entity_dossiers_cached WHERE last_touch_hash LIKE 'gemini-full:%' ORDER BY created_at DESC LIMIT 5;"`,
  );
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
