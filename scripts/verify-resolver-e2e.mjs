#!/usr/bin/env node
/**
 * verify-resolver-e2e.mjs — operator script for Plan 02-05.
 *
 * Publishes 3 synthetic entity.mention.detected events against the live
 * `kos.agent` bus and exercises each resolver stage:
 *
 *   A) auto-merge   — mention "Damien" with project co-occurrence in same
 *                     capture (operator must have a Damien dossier already
 *                     linked to a Project that the same capture references)
 *   B) llm-disambig — mention with alias/typo without project co-occurrence
 *                     ("Lovell"); resolver hits Sonnet 4.6 disambig.
 *                     Outcome 'matched' OR 'inbox-new' both acceptable —
 *                     Sonnet's judgment is non-deterministic. Manual review.
 *   C) inbox-new    — mention that matches nothing
 *                     ("ZzXxNeverHeardOfEntity") → resolver creates a
 *                     KOS Inbox Pending row.
 *
 * Then prints per-case capture_id + asks operator to verify:
 *   - mention.resolved event arrived on kos.agent (CloudWatch metric)
 *   - agent_runs row with agent_name LIKE 'entity-resolver:%' status='ok'
 *   - For A: agent_runs row with agent_name='entity-resolver.merge'
 *            output_json->>'secondary_signal' = 'project_cooccurrence'
 *   - For C: KOS Inbox row with proposed_name='ZzXxNeverHeardOfEntity',
 *            Status=Pending, Source Capture ID = printed ULID
 *
 * Usage:
 *   AWS_PROFILE=kos AWS_REGION=eu-north-1 node scripts/verify-resolver-e2e.mjs
 *
 * Prereqs:
 *   - AWS credentials with PutEvents on kos.agent
 *   - AgentsStack deployed (Plan 02-05 wired)
 *   - Plan 02-07 KOS Inbox DB created (otherwise case C fails inside resolver)
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

// ULID generation kept inline so the script has zero npm-install footprint
// when run from a fresh clone.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  const time = Date.now();
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    timePart = ULID_ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randPart = '';
  for (let i = 0; i < 16; i += 1) {
    randPart += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return timePart + randPart;
}

const region = process.env.AWS_REGION ?? 'eu-north-1';
const eb = new EventBridgeClient({ region });

const cases = [
  {
    key: 'A',
    mention: 'Damien',
    candidate_type: 'Person',
    expect: 'matched (auto-merge with project_cooccurrence)',
    notes:
      'Requires existing Damien dossier in entity_index.linked_projects sharing at least one Project ID with this capture.',
  },
  {
    key: 'B',
    mention: 'Lovell',
    candidate_type: 'Person',
    expect: 'matched OR inbox-new (Sonnet 4.6 judgment; non-deterministic)',
    notes: 'Falls into 0.75–0.95 hybrid score band → llm-disambig stage.',
  },
  {
    key: 'C',
    mention: 'ZzXxNeverHeardOfEntity',
    candidate_type: 'Person',
    expect: 'inbox-new (Pending row in KOS Inbox)',
    notes: 'Verify the Pending row appears with Status=Pending, Source Capture ID = printed ULID.',
  },
];

console.log(`[verify-resolver-e2e] region=${region}`);
console.log('[verify-resolver-e2e] publishing 3 synthetic events to kos.agent...\n');

const published = [];
for (const c of cases) {
  const capture_id = ulid();
  const detail = {
    capture_id,
    mention_text: c.mention,
    context_snippet: `e2e-test-case-${c.key} ${c.mention}`,
    candidate_type: c.candidate_type,
    source: 'telegram-text',
    occurred_at: new Date().toISOString(),
  };
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: 'kos.agent',
          Source: 'kos.agent',
          DetailType: 'entity.mention.detected',
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
  published.push({ ...c, capture_id });
  console.log(`[*] ${c.key} mention="${c.mention}" capture_id=${capture_id}`);
  console.log(`     expect: ${c.expect}`);
  console.log(`     notes: ${c.notes}\n`);
}

console.log('[verify-resolver-e2e] all 3 events published. Verify next:');
console.log('  1. CloudWatch /aws/lambda/KosAgents-EntityResolver*: 3 invocations');
console.log('  2. mention.resolved events on kos.agent (set up a temporary');
console.log('     CloudWatch Events test rule with --enable-event-pattern-matching=false to log)');
console.log('  3. Postgres: SELECT capture_id, agent_name, status, output_json FROM agent_runs');
console.log("     WHERE capture_id IN (...the 3 ULIDs above...) ORDER BY started_at DESC;");
console.log("  4. For case A: SELECT * FROM agent_runs WHERE agent_name='entity-resolver.merge'");
console.log('     AND output_json->>\'secondary_signal\' = \'project_cooccurrence\';');
console.log('  5. For case C: open KOS Inbox in Notion; expect 1 new Pending row with');
console.log('     Proposed Entity Name = "ZzXxNeverHeardOfEntity" + Source Capture ID matching above ULID');
console.log('\n[verify-resolver-e2e] done. Manual review required.');
