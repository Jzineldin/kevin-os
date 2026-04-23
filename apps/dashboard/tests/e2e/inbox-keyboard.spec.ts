import { test } from './fixtures';

// Maps to UI-04 (03-VALIDATION.md Wave 0).
// Wave 0 stub — wired in plan 03-07 (Inbox J/K/Enter/E/S keyboard flow).
test.describe('inbox-keyboard', () => {
  test.fixme('J/K navigate selection, Enter approves, S skips, E opens edit', async () => {
    // Focus /inbox, press J twice -> 3rd row selected. Press Enter ->
    // row dissolves, next row auto-selected. Press E -> edit dialog opens.
  });
});
