/**
 * /api/chat — Next.js proxy for Phase 11 Plan 11-01 POST /chat on
 * dashboard-api.
 *
 * Runtime: nodejs (callApi uses the KOS_DASHBOARD_BEARER_TOKEN env var
 * which isn't available at the Edge).
 *
 * Body schema (forwarded verbatim to upstream):
 *   { message: string, history?: Array<{role, content}> }
 *
 * Response: { answer: string, citations: [{entity_id, name}] }
 *
 * Error mapping:
 *   - Upstream 400 (invalid request) → 400 passthrough
 *   - Upstream 502 (Bedrock unavailable) → 502 passthrough
 *   - Network / auth failure → 502 { error: 'upstream' }
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
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
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
    const data = await callApi(
      '/chat',
      {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      },
      ChatResponseSchema,
    );
    return NextResponse.json(data, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    console.error('[api/chat] upstream failure', err);
    return NextResponse.json({ error: 'upstream' }, { status: 502 });
  }
}
