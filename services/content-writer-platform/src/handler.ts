/**
 * content-writer-platform Lambda (AGT-07 Step Functions Map worker;
 * Plan 08-02 Task 2).
 *
 * Step Functions invokes this Lambda once per platform. Inputs arrive as
 * the per-item shape produced by the Map state's `itemSelector`:
 *   {
 *     topic_id: string,        // ULID — shared across the topic's 5 items
 *     capture_id: string,      // ULID — for trace correlation
 *     topic_text: string,      // Kevin's raw input
 *     platform: 'instagram' | 'linkedin' | 'tiktok' | 'reddit' | 'newsletter'
 *   }
 *
 * Pipeline:
 *   1. getBrandVoice() — fail-closed when human_verification=false (D-25).
 *      No Bedrock call, no DB write — the worker throws and Step Functions
 *      logs the failure for the operator to fix BRAND_VOICE.md.
 *   2. loadContext({ includeCalendar: false }) — Kevin Context + dossier
 *      markdown via @kos/context-loader (Phase 6). Calendar context is
 *      explicitly excluded for content drafting (D-28).
 *   3. runContentWriterAgent — single Sonnet 4.6 EU CRIS call.
 *   4. insertContentDraft — UPSERT into content_drafts with UNIQUE (topic_id,
 *      platform) idempotency.
 *   5. On Bedrock / Zod failure: markDraftFailed inserts a status='failed'
 *      row (or flips an existing draft to failed) and rethrows so Step
 *      Functions sees the error.
 *
 * IAM (CDK helper enforces; CDK tests assert):
 *   - bedrock:InvokeModel on Sonnet 4.6 EU CRIS profile
 *   - rds-db:connect as kos_content_writer_platform
 *   - secrets:GetSecretValue for Sentry / Langfuse keys (when wired)
 *   - **NO postiz:*, NO ses:*** — drafting NEVER publishes
 *
 * `loadContext` requires the @kos/context-loader peer dep + pg.Pool;
 * import is dynamic to keep the dep optional (mirrors email-triage/context.ts
 * fallback). Failure to resolve / call loadContext degrades to an empty
 * additional context block — the brand voice + topic text are sufficient
 * for v1 drafting (CONTEXT D-33).
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { getBrandVoice } from './brand-voice.js';
import {
  runContentWriterAgent,
  type ContentPlatform,
} from './agent.js';
import {
  getPool,
  insertContentDraft,
  markDraftFailed,
} from './persist.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

interface MapItem {
  topic_id: string;
  capture_id: string;
  topic_text: string;
  platform: ContentPlatform;
}

interface MapResult {
  draft_id: string;
  topic_id: string;
  platform: ContentPlatform;
  status: string;
}

export const handler = wrapHandler(async (item: MapItem) => {
  await initSentry();
  await setupOtelTracingAsync();
  const ownerId = process.env.KEVIN_OWNER_ID;
  if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

  tagTraceWithCaptureId(item.capture_id);

  try {
    // Fail-closed gate: throws when BRAND_VOICE.md has human_verification=false.
    // Test 5: no Bedrock call, no DB write reach the body of the try below.
    const brandVoiceMarkdown = getBrandVoice();

    const pool = await getPool();

    // Load Phase 6 context (Kevin Context + entity dossiers + Azure
    // semantic chunks). Calendar context excluded for content drafting per
    // CONTEXT D-28. Dynamic import + try/catch fall through to a thin
    // context bundle on failure so a Phase 6 outage doesn't block drafting.
    const { kevinContext, additionalContextBlock } = await loadContextSafely({
      ownerId,
      captureId: item.capture_id,
      rawText: item.topic_text,
      pool,
    });

    try {
      const { output } = await runContentWriterAgent({
        topicId: item.topic_id,
        captureId: item.capture_id,
        platform: item.platform,
        topicText: item.topic_text,
        brandVoiceMarkdown,
        kevinContextBlock: kevinContext,
        additionalContextBlock,
      });

      const row = await insertContentDraft(pool, {
        ownerId,
        topicId: item.topic_id,
        captureId: item.capture_id,
        platform: item.platform,
        content: output.content,
        mediaUrls: output.media_urls,
      });

      const result: MapResult = {
        draft_id: row.draft_id,
        topic_id: item.topic_id,
        platform: item.platform,
        status: row.status,
      };
      return result;
    } catch (e) {
      // Persist a failure row before rethrowing so the dashboard surfaces
      // the failure and operators can grep content_drafts for status='failed'.
      await markDraftFailed(pool, {
        ownerId,
        topicId: item.topic_id,
        captureId: item.capture_id,
        platform: item.platform,
        error: String(e instanceof Error ? e.message : e),
      });
      throw e;
    }
  } finally {
    await langfuseFlush();
  }
});

/**
 * Try to call @kos/context-loader::loadContext; degrade gracefully on any
 * failure (import error, runtime exception). Mirrors the fallback pattern
 * in services/email-triage/src/context.ts.
 */
async function loadContextSafely(args: {
  ownerId: string;
  captureId: string;
  rawText: string;
  pool: unknown;
}): Promise<{ kevinContext: string; additionalContextBlock: string }> {
  try {
    const mod = await import('@kos/context-loader');
    if (typeof mod?.loadContext !== 'function') {
      return { kevinContext: '', additionalContextBlock: '' };
    }
    const bundle = await mod.loadContext({
      entityIds: [],
      agentName: 'content-writer-platform',
      captureId: args.captureId,
      ownerId: args.ownerId,
      rawText: args.rawText,
      pool: args.pool as never,
    });
    return {
      kevinContext: renderKevinContextMarkdown(bundle.kevin_context),
      additionalContextBlock: bundle.assembled_markdown ?? '',
    };
  } catch (err) {
    // Phase 6 outage / unresolved peer dep / network failure — drafting
    // proceeds with the brand-voice block + topic text only.
    // eslint-disable-next-line no-console
    console.warn(
      '[content-writer-platform] loadContext failed; degrading to brand-voice-only',
      { err: String(err) },
    );
    return { kevinContext: '', additionalContextBlock: '' };
  }
}

interface KevinContextLikeShape {
  current_priorities?: string;
  active_deals?: string;
  whos_who?: string;
  blocked_on?: string;
  recent_decisions?: string;
  open_questions?: string;
}

function renderKevinContextMarkdown(
  block: KevinContextLikeShape | undefined,
): string {
  if (!block) return '';
  const sections: Array<[string, string | undefined]> = [
    ['Current priorities', block.current_priorities],
    ['Active deals', block.active_deals],
    ["Who's who", block.whos_who],
    ['Blocked on', block.blocked_on],
    ['Recent decisions', block.recent_decisions],
    ['Open questions', block.open_questions],
  ];
  return sections
    .filter(([, body]) => body && body.trim())
    .map(([heading, body]) => `## ${heading}\n${body}`)
    .join('\n\n');
}
