import { test } from './fixtures';

// Maps to ENT-07 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-08 (entity merge transactional flow).
test.describe('merge-audit', () => {
  test.fixme('merge writes entity_merge_audit row with ULID merge_id', async () => {
    // Trigger a merge from the UI, assert the audit row exists with
    // action='entity_merge_manual', initiated_by='kevin', merge_id.
  });

  test.fixme('partial merge failure surfaces Resume? card in Inbox', async () => {
    // Force a mid-merge failure, assert partial_merge_state row +
    // an InboxItem of kind=merge_resume keyed to the merge_id.
  });
});
