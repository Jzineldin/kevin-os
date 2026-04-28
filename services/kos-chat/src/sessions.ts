/**
 * Chat session + message persistence.
 *
 * chat_sessions: one row per conversation thread (dashboard or Telegram).
 * chat_messages: ordered messages (user + assistant turns) within a session.
 *
 * Session ID is a ULID — time-sortable, URL-safe, globally unique.
 * source discriminates dashboard vs telegram so we know where to route replies.
 */
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getDb, OWNER_ID } from './db.js';

export type MessageRole = 'user' | 'assistant';
export type SessionSource = 'dashboard' | 'telegram';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ChatSession {
  sessionId: string;
  source: SessionSource;
  /** Telegram chat_id as string (or 'dashboard' for browser sessions). */
  externalId: string;
}

// ── upsert / create session ────────────────────────────────────────────────

/**
 * Resolve a session. If `sessionId` is provided and exists, return it.
 * Otherwise create a new session row and return the new ID.
 */
export async function resolveSession(
  sessionId: string | undefined,
  source: SessionSource,
  externalId: string,
): Promise<string> {
  const db = await getDb();

  if (sessionId) {
    // Verify the session exists and belongs to this owner.
    const r = (await db.execute(sql`
      SELECT session_id
      FROM chat_sessions
      WHERE session_id = ${sessionId}
        AND owner_id = ${OWNER_ID}
      LIMIT 1
    `)) as unknown as { rows: Array<{ session_id: string }> };
    if (r.rows.length > 0 && r.rows[0]) return r.rows[0].session_id;
    // Unknown / expired ID — fall through to create a fresh session.
  }

  const newId = ulid();
  await db.execute(sql`
    INSERT INTO chat_sessions (session_id, owner_id, source, external_id, created_at, last_active_at)
    VALUES (${newId}, ${OWNER_ID}, ${source}, ${externalId}, NOW(), NOW())
    ON CONFLICT (session_id) DO NOTHING
  `);
  return newId;
}

// ── load history ───────────────────────────────────────────────────────────

/**
 * Load the last N turns for a session, oldest-first.
 * Capped at 20 turns (40 messages) to stay within Bedrock context limits.
 */
export async function loadHistory(sessionId: string, maxTurns = 20): Promise<ChatMessage[]> {
  const db = await getDb();
  const r = (await db.execute(sql`
    SELECT role, content
    FROM chat_messages
    WHERE session_id = ${sessionId}
      AND owner_id = ${OWNER_ID}
    ORDER BY seq ASC
    LIMIT ${maxTurns * 2}
  `)) as unknown as { rows: Array<{ role: MessageRole; content: string }> };
  return r.rows;
}

// ── persist messages ───────────────────────────────────────────────────────

/**
 * Append a user+assistant message pair to a session.
 * Uses a CTE to grab the current max(seq) and insert both rows atomically.
 */
export async function appendMessages(
  sessionId: string,
  userContent: string,
  assistantContent: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    WITH next_seq AS (
      SELECT COALESCE(MAX(seq), 0) + 1 AS n
      FROM chat_messages
      WHERE session_id = ${sessionId} AND owner_id = ${OWNER_ID}
    )
    INSERT INTO chat_messages (session_id, owner_id, role, content, seq, created_at)
    SELECT ${sessionId}, ${OWNER_ID}, r, c, s, NOW()
    FROM (
      SELECT 'user'      AS r, ${userContent}      AS c, n     AS s FROM next_seq
      UNION ALL
      SELECT 'assistant' AS r, ${assistantContent} AS c, n + 1 AS s FROM next_seq
    ) AS rows
  `);

  // Keep last_active_at fresh.
  await db.execute(sql`
    UPDATE chat_sessions
    SET last_active_at = NOW()
    WHERE session_id = ${sessionId} AND owner_id = ${OWNER_ID}
  `);
}
