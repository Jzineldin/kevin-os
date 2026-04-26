/**
 * Phase 5 Plan 05-00 scaffold — vitest setup hook for the Chrome extension.
 *
 * Real tests in Plans 05-01 / 05-02 / 05-03 import `installMV3Stub` from
 * `@kos/test-fixtures` to fake `chrome.runtime`, `chrome.storage.local`,
 * `chrome.contextMenus`, and `chrome.alarms` for jsdom-based test runs.
 */
import { installMV3Stub } from '@kos/test-fixtures';

installMV3Stub();
