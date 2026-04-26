/**
 * Phase 5 Plan 05-00 — Vitest-compatible MV3 runtime stub.
 *
 * Chrome MV3 service workers + content scripts assume a global `chrome.*`
 * surface (runtime, storage, alarms, contextMenus). jsdom does not provide
 * one. This stub installs an in-memory fake that implements just the subset
 * the Phase 5 extension touches, so unit tests can run without a real
 * browser.
 *
 * Usage:
 *   import { installMV3Stub, uninstallMV3Stub } from '@kos/test-fixtures';
 *
 *   beforeEach(() => installMV3Stub());
 *   afterEach(() => uninstallMV3Stub());
 *
 * The backing storage is reset on each install() call so tests are
 * isolated. Listener registrations (onMessage, onAlarm, onClicked) are
 * recorded but not dispatched — tests that need to drive callbacks should
 * import the stub state directly.
 */

type Listener = (...args: unknown[]) => unknown;

interface MV3Stub {
  runtime: {
    onMessage: { addListener: (cb: Listener) => void };
    sendMessage: (...args: unknown[]) => Promise<unknown>;
    lastError: { message: string } | null;
    id: string;
  };
  storage: {
    local: {
      get: (keys: string[]) => Promise<Record<string, unknown>>;
      set: (obj: Record<string, unknown>) => Promise<void>;
    };
  };
  alarms: {
    create: (name: string, opts: object) => void;
    onAlarm: { addListener: (cb: Listener) => void };
  };
  contextMenus: {
    create: (opts: object) => void;
    onClicked: { addListener: (cb: Listener) => void };
  };
}

export function installMV3Stub(): void {
  const storageBacking = new Map<string, unknown>();
  const stub: MV3Stub = {
    runtime: {
      onMessage: { addListener: (_cb: Listener) => {} },
      sendMessage: async () => undefined,
      lastError: null,
      id: 'test-ext-id',
    },
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.map((k) => [k, storageBacking.get(k)])),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) storageBacking.set(k, v);
        },
      },
    },
    alarms: {
      create: (_name: string, _opts: object) => {},
      onAlarm: { addListener: (_cb: Listener) => {} },
    },
    contextMenus: {
      create: (_opts: object) => {},
      onClicked: { addListener: (_cb: Listener) => {} },
    },
  };
  (globalThis as unknown as { chrome?: MV3Stub }).chrome = stub;
}

export function uninstallMV3Stub(): void {
  delete (globalThis as unknown as { chrome?: MV3Stub }).chrome;
}
