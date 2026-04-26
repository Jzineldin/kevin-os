/**
 * @kos/chrome-extension — highlight content script (SCAFFOLD).
 *
 * Plan 05-02 wires:
 *   - listen for chrome.contextMenus invocations from background
 *   - read `window.getSelection()`, `document.title`, `location.href`
 *   - chrome.runtime.sendMessage → background → chrome-webhook Lambda
 *
 * No DOM mutations, no observers, no auto-fire — Kevin must explicitly
 * right-click → "Send to KOS" before this script does anything.
 */
export {};
