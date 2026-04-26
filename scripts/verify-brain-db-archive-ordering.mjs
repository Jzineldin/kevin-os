#!/usr/bin/env node
/**
 * verify-brain-db-archive-ordering.mjs — Plan 10-03 ordering invariant test.
 *
 * Audit-first invariant (D-12): the event_log INSERT MUST run BEFORE
 * notion.databases.update on every successful path, and:
 *   - if event_log INSERT fails, notion.databases.update must NEVER be called.
 *   - if notion.databases.update fails, the event_log INSERT row stays
 *     committed (the archive script does not ROLLBACK or DELETE it).
 *
 * This is a UNIT test for the ordering contract. It imports
 * archiveSingleDb from scripts/migrate-brain-dbs.mjs and feeds it
 * hand-rolled mocks so the call ORDER + failure semantics can be
 * asserted with the standard library `assert` module — no vitest, no
 * external test runner required.
 *
 * Run:  node scripts/verify-brain-db-archive-ordering.mjs
 * Exit: 0 on all assertions pass, 1 otherwise.
 */
import assert from 'node:assert/strict';

// Shrink Notion retry backoff for the failure-mode tests so the suite
// completes in <1 s instead of 21 s. The migrate-brain-dbs module reads
// this env var at import time.
process.env.KOS_NOTION_RETRY_DELAYS_MS ??= '1,1,1';

const { archiveSingleDb } = await import('./migrate-brain-dbs.mjs');

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Build a mock pg client whose `query` records every call to `events` and
 * either resolves with `defaultRows` or throws based on per-call behaviour.
 */
function makeMockPg({ insertResult, insertThrows, events }) {
  return {
    query: async (sql, params) => {
      const stripped = sql.replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO event_log/i.test(stripped)) {
        events.push({ kind: 'pg.INSERT', sql: stripped, params });
        if (insertThrows) throw insertThrows;
        return insertResult ?? { rows: [{ id: 'evt-test-001' }] };
      }
      if (/^UPDATE event_log/i.test(stripped)) {
        events.push({ kind: 'pg.UPDATE', sql: stripped, params });
        return { rowCount: 1 };
      }
      events.push({ kind: 'pg.OTHER', sql: stripped, params });
      return { rows: [] };
    },
  };
}

/**
 * Build a mock Notion client that records databases.retrieve + .update
 * into the shared event log; configurable to throw on update.
 */
function makeMockNotion({ retrieveResult, updateThrows, events }) {
  return {
    databases: {
      retrieve: async (params) => {
        events.push({ kind: 'notion.retrieve', params });
        return (
          retrieveResult ?? {
            archived: false,
            title: [{ plain_text: 'Test Brain DB' }],
          }
        );
      },
      update: async (params) => {
        events.push({ kind: 'notion.update', params });
        if (updateThrows) throw updateThrows;
        return { id: params.database_id, archived: params.archived };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];

tests.push({
  name: 'happy path: ordering = retrieve → INSERT event_log → update Notion → UPDATE event_log',
  run: async () => {
    const events = [];
    const notion = makeMockNotion({ events });
    const pgClient = makeMockPg({ events });
    const out = await archiveSingleDb({
      notion,
      pg: pgClient,
      db: { id: 'db-test-1', name: 'Brain DB Test' },
      ownerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      force: false,
      isoDate: '2026-04-25T00:00:00Z',
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.eventLogId, 'evt-test-001');
    // Order assertion: indices must monotonically increase.
    const idxRetrieve = events.findIndex((e) => e.kind === 'notion.retrieve');
    const idxInsert = events.findIndex((e) => e.kind === 'pg.INSERT');
    const idxUpdate = events.findIndex((e) => e.kind === 'notion.update');
    const idxAck = events.findIndex((e) => e.kind === 'pg.UPDATE');
    assert.ok(
      idxRetrieve >= 0 && idxInsert > idxRetrieve,
      'event_log INSERT must come AFTER databases.retrieve',
    );
    assert.ok(
      idxInsert < idxUpdate,
      `event_log INSERT must come BEFORE notion.databases.update — got insert@${idxInsert} update@${idxUpdate}`,
    );
    assert.ok(idxUpdate < idxAck, 'notion_ack_at UPDATE must come AFTER notion.databases.update');
    // Title prefix in INSERT detail is the [MIGRERAD-DATE] form.
    const insertEvent = events[idxInsert];
    const detail = JSON.parse(insertEvent.params[1]);
    assert.match(detail.new_title, /^\[MIGRERAD-2026-04-25\]/);
    assert.equal(detail.database_id, 'db-test-1');
    assert.equal(detail.original_title, 'Test Brain DB');
  },
});

tests.push({
  name: 'failure mode 1: pg.INSERT throws → notion.databases.update is NEVER called',
  run: async () => {
    const events = [];
    const notion = makeMockNotion({ events });
    const pgClient = makeMockPg({
      events,
      insertThrows: new Error('simulated pg connection refused'),
    });
    let caught;
    try {
      await archiveSingleDb({
        notion,
        pg: pgClient,
        db: { id: 'db-test-2', name: 'Brain DB Test 2' },
        ownerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
        force: false,
        isoDate: '2026-04-25T00:00:00Z',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected archiveSingleDb to throw when INSERT fails');
    const updateCalls = events.filter((e) => e.kind === 'notion.update');
    assert.equal(
      updateCalls.length,
      0,
      'notion.databases.update must NOT be called when event_log INSERT failed',
    );
  },
});

tests.push({
  name: 'failure mode 2: notion.update throws → audit row already committed (no rollback/delete)',
  run: async () => {
    const events = [];
    const notion = makeMockNotion({
      events,
      updateThrows: Object.assign(new Error('Notion 502'), { status: 502 }),
    });
    const pgClient = makeMockPg({ events });
    let caught;
    try {
      await archiveSingleDb({
        notion,
        pg: pgClient,
        db: { id: 'db-test-3', name: 'Brain DB Test 3' },
        ownerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
        force: false,
        isoDate: '2026-04-25T00:00:00Z',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected archiveSingleDb to propagate notion.update failure');
    // Exactly one INSERT, no DELETE / ROLLBACK / UPDATE-ack.
    const inserts = events.filter((e) => e.kind === 'pg.INSERT');
    const ackUpdates = events.filter((e) => e.kind === 'pg.UPDATE');
    const otherPg = events.filter((e) => e.kind === 'pg.OTHER');
    assert.equal(inserts.length, 1, 'expected exactly 1 event_log INSERT (intent recorded)');
    assert.equal(
      ackUpdates.length,
      0,
      'notion_ack_at UPDATE must NOT run when notion.update failed',
    );
    // Verify no rollback/delete patterns leaked.
    for (const e of otherPg) {
      assert.ok(
        !/^(ROLLBACK|DELETE FROM event_log)/i.test(e.sql),
        `unexpected destructive pg call after Notion failure: ${e.sql}`,
      );
    }
  },
});

tests.push({
  name: 'idempotency: already-archived + [MIGRERAD-] prefix → skip without writing event_log',
  run: async () => {
    const events = [];
    const notion = makeMockNotion({
      events,
      retrieveResult: {
        archived: true,
        title: [{ plain_text: '[MIGRERAD-2026-04-20] Brain DB Personal' }],
      },
    });
    const pgClient = makeMockPg({ events });
    const out = await archiveSingleDb({
      notion,
      pg: pgClient,
      db: { id: 'db-test-4', name: 'Brain DB Personal' },
      ownerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      force: false,
      isoDate: '2026-04-25T00:00:00Z',
    });
    assert.equal(out.status, 'skip');
    const inserts = events.filter((e) => e.kind === 'pg.INSERT');
    const updates = events.filter((e) => e.kind === 'notion.update');
    assert.equal(inserts.length, 0, 'no event_log INSERT on idempotent skip');
    assert.equal(updates.length, 0, 'no Notion mutation on idempotent skip');
  },
});

tests.push({
  name: '--force: already-archived + [MIGRERAD-] prefix → re-archive with stripped prefix',
  run: async () => {
    const events = [];
    const notion = makeMockNotion({
      events,
      retrieveResult: {
        archived: true,
        title: [{ plain_text: '[MIGRERAD-2026-04-20] Brain DB Personal' }],
      },
    });
    const pgClient = makeMockPg({ events });
    const out = await archiveSingleDb({
      notion,
      pg: pgClient,
      db: { id: 'db-test-5', name: 'Brain DB Personal' },
      ownerId: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
      force: true,
      isoDate: '2026-04-25T00:00:00Z',
    });
    assert.equal(out.status, 'ok');
    // The new title must NOT have a doubled prefix.
    assert.equal(out.newTitle, '[MIGRERAD-2026-04-25] Brain DB Personal');
    const insertEvent = events.find((e) => e.kind === 'pg.INSERT');
    const detail = JSON.parse(insertEvent.params[1]);
    assert.equal(detail.forced, true);
    assert.equal(detail.archived_before, true);
  },
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.run();
      pass++;
      console.log(`[PASS] ordering: ${t.name}`);
    } catch (err) {
      fail++;
      console.error(`[FAIL] ordering: ${t.name}`);
      console.error(`       ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log('');
  console.log(`[SUMMARY] ordering tests pass=${pass} fail=${fail} (of ${tests.length})`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
