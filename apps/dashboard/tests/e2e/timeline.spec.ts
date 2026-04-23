import { test } from './fixtures';

// Maps to ENT-08 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-05 (timeline + react-window pagination).
test.describe('timeline', () => {
  test.fixme('first 50 rows SSR + cursor-paginated scroll loads next page', async () => {
    // Scroll to the 40th row, assert fetch('/entities/:id/timeline?cursor=…')
    // fires once, rows append without layout reflow.
  });
});
