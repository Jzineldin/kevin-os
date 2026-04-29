/**
 * push-discord Lambda — routes kos.output events to #kos-development via webhook.
 *
 * Triggered by EventBridge rule on kos.output bus (same as push-telegram).
 * Formats events as Discord embeds and POSTs to the webhook URL stored in
 * Secrets Manager (kos/discord-webhook-kos-dev).
 *
 * Handles:
 *   - output.push (morning-brief, day-close, weekly-review) → full message embed
 *   - capture_ack / inbox_item / draft_ready → brief notification
 *   - error events → red embed
 *
 * NO cap enforcement — Discord is a dev channel, not a quiet-hours surface.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

let webhookUrlCache: string | null = null;

async function getWebhookUrl(): Promise<string> {
  if (webhookUrlCache) return webhookUrlCache;
  const arn =
    process.env.DISCORD_WEBHOOK_SECRET_ARN ??
    'arn:aws:secretsmanager:eu-north-1:239541130189:secret:kos/discord-webhook-kos-dev-dhrhHa';
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = res.SecretString ?? '';
  let url = raw;
  if (raw.startsWith('{')) { try { const p = JSON.parse(raw) as Record<string,unknown>; url = String(p['url'] ?? ''); } catch {} }
  
  if (!url.startsWith('https://')) throw new Error('Invalid webhook URL from Secrets Manager');
  webhookUrlCache = url;
  return url;
}

// ── Color palette ───────────────────────────────────────────────────────────
const COLORS = {
  morning: 0xf4a261,   // warm orange
  evening: 0x4a90d9,   // blue
  weekly:  0x9b59b6,   // purple
  error:   0xe74c3c,   // red
  capture: 0x2ecc71,   // green
  draft:   0x3498db,   // light blue
  info:    0x95a5a6,   // grey
} as const;

// ── Discord embed builder ───────────────────────────────────────────────────
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordPayload {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
}

function truncate(s: string, max = 1024): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function formatOutputPush(detail: Record<string, unknown>): DiscordPayload {
  const body = String(detail.body ?? '');
  const detailType = String(detail['detail-type'] ?? detail.kind ?? 'update');
  const isMorning = body.toLowerCase().includes('morning') || detailType.includes('morning');
  const isEvening = detailType.includes('close') || body.toLowerCase().includes('day close');
  const isWeekly = detailType.includes('weekly');

  const color = isWeekly ? COLORS.weekly : isEvening ? COLORS.evening : COLORS.morning;
  const emoji = isWeekly ? '📊' : isEvening ? '🌙' : '🌅';
  const title = isWeekly ? 'Weekly Review' : isEvening ? 'Day Close' : 'Morning Brief';

  // Split body into lines for preview (first 800 chars)
  const preview = truncate(body, 800);

  return {
    username: 'KOS System',
    embeds: [{
      title: `${emoji} ${title}`,
      description: preview || '*(no content)*',
      color,
      footer: { text: 'kos.output → push-discord' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function formatEventBridgeEvent(event: Record<string, unknown>): DiscordPayload {
  const detailType = String(event['detail-type'] ?? event.detailType ?? 'event');
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const source = String(event.source ?? 'kos');

  // output.push (briefs)
  if (detailType === 'output.push') {
    return formatOutputPush({ ...detail, 'detail-type': detailType });
  }

  // Error events
  if (detailType.includes('error') || String(detail.error ?? '').length > 0) {
    return {
      username: 'KOS System',
      embeds: [{
        title: '🚨 KOS Error',
        description: truncate(JSON.stringify(detail, null, 2), 800),
        color: COLORS.error,
        fields: [{ name: 'Source', value: source, inline: true }],
        footer: { text: detailType },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // capture_ack
  if (detailType === 'capture_ack') {
    const id = String(detail.capture_id ?? detail.id ?? '?');
    return {
      username: 'KOS System',
      embeds: [{
        title: '✅ Capture ACK',
        description: truncate(String(detail.body ?? detail.text ?? '(captured)'), 300),
        color: COLORS.capture,
        fields: [{ name: 'ID', value: id.slice(0, 20), inline: true }],
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // draft_ready
  if (detailType === 'draft_ready') {
    return {
      username: 'KOS System',
      embeds: [{
        title: '✉️ Draft Ready',
        description: truncate(String(detail.subject ?? detail.id ?? '?'), 300),
        color: COLORS.draft,
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // inbox_item
  if (detailType === 'inbox_item') {
    const from = String(detail.from_name ?? detail.from ?? '?');
    const subj = String(detail.subject ?? detail.body ?? '(no subject)');
    return {
      username: 'KOS System',
      embeds: [{
        title: '📥 Inbox Item',
        description: truncate(subj, 300),
        color: COLORS.info,
        fields: [{ name: 'From', value: from, inline: true }],
        timestamp: new Date().toISOString(),
      }],
    };
  }

  // Generic fallback
  const body = detail.body ?? detail.text ?? detail.message;
  return {
    username: 'KOS System',
    embeds: [{
      title: `📡 ${detailType}`,
      description: body ? truncate(String(body), 500) : truncate(JSON.stringify(detail), 500),
      color: COLORS.info,
      fields: [{ name: 'Source', value: source, inline: true }],
      footer: { text: 'kos.output' },
      timestamp: new Date().toISOString(),
    }],
  };
}

async function postToDiscord(payload: DiscordPayload): Promise<void> {
  const url = await getWebhookUrl();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '?');
    throw new Error(`Discord webhook ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── Lambda handler ──────────────────────────────────────────────────────────
export async function handler(event: Record<string, unknown>): Promise<{ ok: boolean }> {
  console.log('[push-discord] event', JSON.stringify(event).slice(0, 500));

  try {
    const payload = formatEventBridgeEvent(event);
    await postToDiscord(payload);
    console.log('[push-discord] sent OK');
    return { ok: true };
  } catch (err) {
    console.error('[push-discord] failed', err);
    // Don't re-throw — Discord is non-critical, don't waste EB retries
    return { ok: false };
  }
}
