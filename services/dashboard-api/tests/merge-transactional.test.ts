import { describe, it } from 'vitest';

// Wave 0 stub — wired in plan 03-08 (merge transactional path).
describe('merge transactional', () => {
  it.todo('single-txn merge: copy relations -> archive source -> update entity_index');
  it.todo('writes agent_runs audit row with action=entity_merge_manual + ULID merge_id');
});
