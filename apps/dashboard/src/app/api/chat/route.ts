/**
 * /api/chat — Next.js proxy for Phase 11 Plan 11-02 kos-chat Lambda.
 *
 * Calls the kos-chat Lambda Function URL directly (not dashboard-api).
 * The Lambda has its own session management via chat_sessions/chat_messages tables.
 *
 * Runtime: nodejs (needs KOS_CHAT_FUNCTION_URL and KOS_DASHBOARD_BEARER_TOKEN).
 *
 * Body schema:
 *   { message: string, sessionId?: string, source?: 'dashboard'|'telegram', externalId?: string }
 *
 * Response: { answer: string, citations: [{entity_id, name}], sessionId: string, mutations?: [] }
 *
 * Error mapping:
 *   - Upstream 400 (invalid request) → 400 passthrough
 *   - Upstream 502 (Bedrock unavailable) → 502 passthrough
 *   - Network / auth failure → 502 { error: 'upstream' }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatResponseSchema = z.object({
  answer: z.string(),
  citations: z
    .array(
      z.object({
        entity_id: z.string(),
        name: z.string(),
      }),
    )
    .default([]),
  sessionId: z.string(),
  mutations: z.array(z.record(z.unknown())).optional(),
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
  source: z.enum(['dashboard', 'telegram']).default('dashboard'),
  externalId: z.string().max(64).default('default'),
});

export async function POST(req: Request) {
  const functionUrl = process.env.KOS_CHAT_FUNCTION_URL;
  if (!functionUrl) {
    console.error('[api/chat] KOS_CHAT_FUNCTION_URL not set');
    return NextResponse.json({ error: 'config_missing' }, { status: 500 });
  }

  const bearer = process.env.KOS_DASHBOARD_BEARER_TOKEN;
  if (!bearer) {
    console.error('[api/chat] KOS_DASHBOARD_BEARER_TOKEN not set');
    return NextResponse.json({ error: 'config_missing' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues.slice(0, 3) },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${bearer}`,
      },
      body: JSON.stringify(parsed.data),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[api/chat] Lambda responded ${res.status}: ${text.slice(0, 200)}`);
      return NextResponse.json(
        { error: 'upstream', detail: text.slice(0, 200) },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502 },
      );
    }

    const data = await res.json();
    const validated = ChatResponseSchema.parse(data);
    return NextResponse.json(validated, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    console.error('[api/chat] upstream failure', err);
    return NextResponse.json(
      { error: 'upstream', detail: String(err).slice(0, 200) },
      { status: 502 },
    );
  }
}
