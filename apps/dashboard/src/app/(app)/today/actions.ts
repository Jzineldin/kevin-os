'use server';

import { callApi } from '@/lib/dashboard-api';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const OkSchema = z.object({ ok: z.boolean() });

export async function markPriorityDone(id: string): Promise<void> {
  await callApi(`/priorities/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'done' }),
  }, OkSchema);
  revalidatePath('/today');
}

export async function markPriorityDefer(id: string): Promise<void> {
  await callApi(`/priorities/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'defer' }),
  }, OkSchema);
  revalidatePath('/today');
}

export async function delegateToZinclaw(params: {
  kind: string;
  id: string;
  title: string;
  context?: string;
}): Promise<void> {
  await callApi('/delegate', {
    method: 'POST',
    body: JSON.stringify(params),
  }, OkSchema);
}

export async function captureText(text: string): Promise<{ ok: boolean; capture_id: string }> {
  const { callApi } = await import('@/lib/dashboard-api');
  const { z } = await import('zod');
  const Schema = z.object({ ok: z.boolean(), capture_id: z.string() });
  return callApi('/capture', { method: 'POST', body: JSON.stringify({ text, source: 'dashboard' }) }, Schema);
}
