import { test } from './fixtures';

// Maps to UI-02 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-05 (per-entity dossier).
test.describe('entity', () => {
  test.fixme('Person dossier renders AI block + stats + linked projects', async () => {
    // GET /entities/{uuid}, assert header, ai_block, linked_projects list,
    // stats side rail.
  });

  test.fixme('Project dossier shares template but swaps role metadata', async () => {
    // Same entity route, type=Project fixture, assert Project-specific layout.
  });
});
