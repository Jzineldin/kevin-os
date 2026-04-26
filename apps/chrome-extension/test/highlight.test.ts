/**
 * Phase 5 / Plan 05-01 Task 1 — background highlight integration test.
 *
 * Drives `handleContextMenuClick` directly (the listener wraps it in a
 * fire-and-forget `void` so testing through the chrome.contextMenus
 * onClicked stub would lose the await chain).
 *
 * Mocks:
 *   - chrome.* via @kos/test-fixtures.installMV3Stub (in-memory storage,
 *     no-op listeners).
 *   - globalThis.fetch via vitest.fn so we can introspect the request
 *     headers + body the extension would send to the chrome-webhook
 *     Lambda Function URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installMV3Stub, uninstallMV3Stub } from '@kos/test-fixtures';

describe('background highlight flow', () => {
  beforeEach(() => {
    installMV3Stub();
  });

  function fakeInfo(text: string | undefined): chrome.contextMenus.OnClickData {
    return {
      menuItemId: 'kos-send-to-kos',
      editable: false,
      pageUrl: 'https://example.com/article',
      selectionText: text,
    } as unknown as chrome.contextMenus.OnClickData;
  }
  function fakeTab(url?: string, title?: string): chrome.tabs.Tab {
    return {
      id: 1,
      index: 0,
      pinned: false,
      highlighted: false,
      windowId: 0,
      active: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      url,
      title,
    } as unknown as chrome.tabs.Tab;
  }

  it('not configured → no fetch, silent warn', async () => {
    const fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { handleContextMenuClick } = await import('../src/background');
    await handleContextMenuClick(
      fakeInfo('hello world'),
      fakeTab('https://example.com/'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('configured + non-empty selection + tab.url → POST with Bearer + X-KOS-Signature', async () => {
    await chrome.storage.local.set({
      bearer: 'abc',
      webhookUrl: 'https://kw.example.com',
      hmacSecret: 'shh',
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    const { handleContextMenuClick } = await import('../src/background');
    await handleContextMenuClick(
      fakeInfo('Damien Hateley said the deal closes Friday'),
      fakeTab('https://news.ycombinator.com/item?id=42', 'HN — Story'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://kw.example.com/highlight');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer abc');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-KOS-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.channel).toBe('chrome');
    expect(body.kind).toBe('chrome_highlight');
    expect(body.text).toBe('Damien Hateley said the deal closes Friday');
    expect(body.source_url).toBe('https://news.ycombinator.com/item?id=42');
    expect(body.source_title).toBe('HN — Story');
    expect(typeof body.capture_id).toBe('string');
    expect((body.capture_id as string).length).toBe(26);
    expect(typeof body.selected_at).toBe('string');
  });

  it('empty selection → silent no-op (no fetch)', async () => {
    await chrome.storage.local.set({
      bearer: 'abc',
      webhookUrl: 'https://kw.example.com',
      hmacSecret: 'shh',
    });
    const fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    const { handleContextMenuClick } = await import('../src/background');
    await handleContextMenuClick(fakeInfo(undefined), fakeTab('https://x.test/'));
    await handleContextMenuClick(fakeInfo(''), fakeTab('https://x.test/'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chrome:// page (no tab.url) → silent no-op (no fetch)', async () => {
    await chrome.storage.local.set({
      bearer: 'abc',
      webhookUrl: 'https://kw.example.com',
      hmacSecret: 'shh',
    });
    const fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    const { handleContextMenuClick } = await import('../src/background');
    await handleContextMenuClick(fakeInfo('blah'), fakeTab(undefined));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wrong menu id → no fetch (defence in depth)', async () => {
    await chrome.storage.local.set({
      bearer: 'abc',
      webhookUrl: 'https://kw.example.com',
      hmacSecret: 'shh',
    });
    const fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    const { handleContextMenuClick } = await import('../src/background');
    await handleContextMenuClick(
      { ...fakeInfo('text'), menuItemId: 'something-else' } as chrome.contextMenus.OnClickData,
      fakeTab('https://x.test/'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetch throws → no rethrow (caller never sees the error)', async () => {
    await chrome.storage.local.set({
      bearer: 'abc',
      webhookUrl: 'https://kw.example.com',
      hmacSecret: 'shh',
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { handleContextMenuClick } = await import('../src/background');
    // Should resolve, not throw.
    await expect(
      handleContextMenuClick(
        fakeInfo('text'),
        fakeTab('https://x.test/'),
      ),
    ).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

// Final cleanup hook for the suite (vitest's afterAll equivalent without
// importing it).
import { afterAll } from 'vitest';
afterAll(() => uninstallMV3Stub());
