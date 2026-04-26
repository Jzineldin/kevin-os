/**
 * @kos/service-baileys-fargate — CAP-06 Baileys WhatsApp gateway (SCAFFOLD).
 *
 * Long-running Fargate container. Maintains a persistent WebSocket to
 * WhatsApp via the Baileys library, streams every incoming message to the
 * `baileys-sidecar` Lambda Function URL with the X-BAILEYS-Secret header,
 * and persists Signal-protocol session keys in RDS via the
 * `whatsapp_session_keys` table (pluggable Baileys auth provider).
 *
 * Plan 05-04 is `autonomous: false` (operator-driven QR pairing + risk
 * acceptance) so this scaffold ONLY exists to lock the workspace shape so
 * the Plan 05-05 sidecar can compile against the same shared types. `main`
 * is intentionally only invoked when the file is the process entrypoint —
 * importing the module (e.g., from tests) is a no-op so vitest can resolve
 * the workspace without tripping the SCAFFOLD throw.
 */
export async function main(): Promise<never> {
  throw new Error(
    'Phase 5 service baileys-fargate: container entrypoint not yet implemented — see Plan 05-04',
  );
}

// Run when invoked directly (e.g., `node dist/entrypoint.js` inside the Docker
// container CMD); import-time is a no-op so tests + typecheck stay green.
const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('entrypoint.js');
if (isMain) {
  void main();
}
