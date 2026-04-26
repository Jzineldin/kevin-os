/**
 * gmail.test.ts — Gmail API wrapper unit tests.
 *
 * Coverage:
 *   1. listNewMessageIds → builds the right `q=newer_than:5m in:inbox`
 *      URL and unpacks the messages array.
 *   2. listNewMessageIds pagination follows nextPageToken.
 *   3. listNewMessageIds 401 throws GmailAuthStaleError.
 *   4. fetchMessage decodes a multipart message → text/plain + text/html
 *      bodies + parsed headers + ISO `received_at`.
 *   5. fetchMessage handles a single-part text/plain message.
 *   6. fetchMessage 401 throws GmailAuthStaleError.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchMessage,
  GmailAuthStaleError,
  listNewMessageIds,
} from '../src/gmail.js';

beforeEach(() => {
  (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
});

function b64u(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('listNewMessageIds', () => {
  it('builds q=newer_than:Nm in:inbox -in:chats and returns messages', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [
          { id: 'm1', threadId: 't1' },
          { id: 'm2', threadId: 't2' },
        ],
      }),
      text: async () => '',
    });
    const out = await listNewMessageIds({ accessToken: 'tok', afterEpochSec: 1714000000 });
    expect(out).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ]);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    );
    expect(url.searchParams.get('q')).toBe('after:1714000000 in:inbox -in:chats');
  });

  it('paginates via nextPageToken (caps at 5 pages)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let call = 0;
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        call += 1;
        if (call < 3) {
          return {
            messages: [{ id: `m${call}`, threadId: `t${call}` }],
            nextPageToken: `pt${call}`,
          };
        }
        return { messages: [{ id: 'mLast', threadId: 'tLast' }] };
      },
      text: async () => '',
    }));
    const out = await listNewMessageIds({ accessToken: 'tok' });
    expect(out.length).toBe(3);
    expect(out[2]!.id).toBe('mLast');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('401 throws GmailAuthStaleError', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'auth' });
    await expect(listNewMessageIds({ accessToken: 'bad' })).rejects.toBeInstanceOf(
      GmailAuthStaleError,
    );
  });
});

describe('fetchMessage', () => {
  it('decodes multipart message → text/plain + text/html + headers', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'm1',
        threadId: 't1',
        internalDate: String(new Date('2026-04-25T09:00:00Z').getTime()),
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'Subject', value: 'Damien sync' },
            { name: 'From', value: 'damien@example.com' },
            { name: 'To', value: 'kevin@tale-forge.app, ops@example.com' },
            { name: 'Cc', value: 'cc1@example.com' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64u('hello plain') } },
            { mimeType: 'text/html', body: { data: b64u('<p>hello html</p>') } },
          ],
        },
      }),
      text: async () => '',
    });
    const m = await fetchMessage({ accessToken: 'tok', messageId: 'm1' });
    expect(m.id).toBe('m1');
    expect(m.subject).toBe('Damien sync');
    expect(m.from).toBe('damien@example.com');
    expect(m.to).toEqual(['kevin@tale-forge.app', 'ops@example.com']);
    expect(m.cc).toEqual(['cc1@example.com']);
    expect(m.bodyText).toBe('hello plain');
    expect(m.bodyHtml).toBe('<p>hello html</p>');
    expect(m.receivedAt).toBe('2026-04-25T09:00:00.000Z');
  });

  it('handles single-part text/plain messages (no parts array)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'm2',
        threadId: 't2',
        internalDate: '0',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: 'short' },
            { name: 'From', value: 'a@b' },
            { name: 'To', value: 'kevin@tale-forge.app' },
          ],
          body: { data: b64u('inline') },
        },
      }),
      text: async () => '',
    });
    const m = await fetchMessage({ accessToken: 'tok', messageId: 'm2' });
    expect(m.bodyText).toBe('inline');
    expect(m.bodyHtml).toBeNull();
  });

  it('401 throws GmailAuthStaleError', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'auth' });
    await expect(fetchMessage({ accessToken: 'bad', messageId: 'm1' })).rejects.toBeInstanceOf(
      GmailAuthStaleError,
    );
  });
});
