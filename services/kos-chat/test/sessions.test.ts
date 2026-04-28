/**
 * sessions.ts unit tests — all DB calls mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB — must be before importing sessions.ts
const mockExecute = vi.fn();
vi.mock('../src/db.js', () => ({
  OWNER_ID: '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c',
  getDb: vi.fn().mockResolvedValue({ execute: (...args: unknown[]) => mockExecute(...args) }),
  getPool: vi.fn().mockResolvedValue({}),
}));

vi.mock('drizzle-orm', () => ({
  sql: vi.fn().mockImplementation((tpl: TemplateStringsArray, ..._vals: unknown[]) => tpl.join('?')),
}));

import { resolveSession, loadHistory, appendMessages } from '../src/sessions.js';

describe('resolveSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns existing sessionId when DB confirms it exists', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_id: 'EXISTING' }] });
    const id = await resolveSession('EXISTING', 'dashboard', 'default');
    expect(id).toBe('EXISTING');
  });

  it('creates new session when sessionId not found in DB', async () => {
    // First call (SELECT) returns empty rows → session not found.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Second call (INSERT) returns undefined.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    const id = await resolveSession('UNKNOWN', 'dashboard', 'default');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10); // ULID
  });

  it('creates new session when no sessionId provided', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    const id = await resolveSession(undefined, 'telegram', '123456789');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10);
  });
});

describe('loadHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no messages', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    const msgs = await loadHistory('SESSION-01');
    expect(msgs).toEqual([]);
  });

  it('returns messages in order', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
    const msgs = await loadHistory('SESSION-01');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[1]?.role).toBe('assistant');
  });
});

describe('appendMessages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls execute twice (INSERT + UPDATE)', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await appendMessages('SESSION-01', 'user msg', 'assistant reply');
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
