/**
 * /api/chat — Next.js proxy for KOS Chat via dashboard-api Lambda (Phase 11).
 *
 * Calls dashboard-api POST /chat (Bearer-auth, AWS_IAM Lambda Function URL)
 * via the shared `callApi` helper which manages auth + validation.
 *
 * Why proxy through Next.js instead of calling dashboard-api directly from
 * the browser:
 *   - Bearer token must never be sent to the browser.
 *   - CORS: dashboard-api only allows Vercel origin.
 *   - Consistent with existing API route pattern (entities, calendar, etc.)
 *
 * Previous implementation called a standalone kos-chat Lambda via
 * KOS_CHAT_FUNCTION_URL (Phase 11-01 Plan 11-02). Reverted 2026-04-29 because
 * Lambda Function URL AWS_IAM auth is not callable from Vercel without
 * SigV4 credentials, and NONE auth with public principal has undocumented ACL
 * quirks. dashboard-api already has a full /chat route (tool-use + context
 * loading + entity citations) with reliable Bearer auth — use that.
 *
 * Runtime: nodejs (uses process.env vars available server-side only).
 *
 * Backend URL: KOS_DASHBOARD_API_URL → https://v1k7d48lbk.execute-api.eu-north-1.amazonaws.com/
 * (API Gateway HTTP API → dashboard-api Lambda via VPC, bypasses SCP on Lambda Function URLs)
 *
 * Body schema (passed through):
 *   { message: string, sessionId?: string, source?: 'dashboard'|'telegram', externalId?: string, history?: [...] }
 *
 * Response:
 *   { answer: string, citations: [{entity_id, name}], sessionId: string, mutations?: [] }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { callApi } from '@/lib/dashboard-api';

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
  mutations: z.array(z.record(z.unknown())).optional().default([]),
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
  source: z.enum(['dashboard', 'telegram']).default('dashboard'),
  externalId: z.string().max(64).default('default'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional(),
});

export async function POST(req: Request) {
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
    const data = await callApi('/chat', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
    }, ChatResponseSchema);

    return NextResponse.json(data, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    // Surface upstream status codes (400 / 502) faithfully.
    const status = msg.includes('→ 4') ? 400 : 502;
    console.error('[api/chat] upstream failure', msg.slice(0, 400));
    return NextResponse.json(
      { error: 'upstream', detail: msg.slice(0, 400) },
      { status },
    );
  }
}
