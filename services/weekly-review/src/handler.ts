/**
 * Phase 7 Plan 07-02 — weekly-review Lambda (AUTO-04).
 *
 * Fires Sunday 19:00 Stockholm via EventBridge Scheduler. End-to-end flow:
 *
 *   1. initSentry + setupOtelTracingAsync
 *   2. Generate brief_capture_id := ulid()
 *   3. Idempotency claim — INSERT agent_runs status='started' if no prior ok row.
 *   4. Compute week window: last 7 days inclusive of today (Sunday) ─ Stockholm.
 *      weekStart = today - 6 days; weekEndExclusive = today + 1 day.
 *   5. Parallel: loadHotEntities (top 20 by 7-day mention count) +
 *                loadWeekRecapHint (UNION ALL aggregate counts).
 *   6. loadContext({ entityIds: hot, agentName: 'weekly-review', captureId, ownerId,
 *                    pool, azureSearch: hybridQuery wrapper }).
 *   7. runWeeklyReviewAgent — Sonnet 4.6 tool_use → WeeklyReview.
 *   8. NO writeTop3Membership — WeeklyReviewSchema has no top_three (D-05).
 *   9. Notion side-effects via Promise.allSettled — best effort:
 *        a. replaceActiveThreadsSection (Kevin Context page, overwrite section)
 *        b. appendDailyBriefLogPage (Daily Brief Log DB row, Type=weekly-review)
 *  10. Emit ONE output.push to kos.output (Sunday 1-of-3 cap).
 *  11. updateAgentRunSuccess.
 *
 * Quiet-hours: 19:00 Stockholm is OUTSIDE the 20:00–08:00 window — D-18
 * doesn't apply.
 *
 * On Bedrock failure: updateAgentRunError + emit kos.system / brief.generation_failed.
 * Returns { status: 'error' } WITHOUT throwing so EventBridge doesn't retry-storm.
 */
import { initSentry, wrapHandler } from '../../_shared/sentry.js';
import {
  setupOtelTracingAsync,
  flush as langfuseFlush,
  tagTraceWithCaptureId,
} from '../../_shared/tracing.js';
import { ulid } from 'ulid';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { loadContext } from '@kos/context-loader';
import { hybridQuery } from '@kos/azure-search';

import {
  getPool,
  insertAgentRunStarted,
  updateAgentRunSuccess,
  updateAgentRunError,
  loadHotEntities,
  loadWeekRecapHint,
} from './persist.js';
import { runWeeklyReviewAgent } from './agent.js';
import {
  replaceActiveThreadsSection,
  appendDailyBriefLogPage,
} from './notion.js';
import {
  renderDailyBriefLogPage,
  renderTelegramHtml,
  stockholmDateKey,
} from '../../_shared/brief-renderer.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

interface WeeklyReviewHandlerSuccess {
  brief_capture_id: string;
  week_recap_count: number;
  next_week_count: number;
  active_threads_status: 'fulfilled' | 'rejected';
  notion_log_status: 'fulfilled' | 'rejected';
}

interface WeeklyReviewHandlerSkipped {
  skipped: 'duplicate';
}

interface WeeklyReviewHandlerError {
  status: 'error';
  brief_capture_id: string;
  error: string;
}

type WeeklyReviewHandlerResult =
  | WeeklyReviewHandlerSuccess
  | WeeklyReviewHandlerSkipped
  | WeeklyReviewHandlerError;

/**
 * Compute Stockholm date N days ago (YYYY-MM-DD). Used to derive the
 * week-start anchor (today - 6 days = inclusive 7-day window).
 */
function stockholmDateNDaysAgo(n: number, now: Date = new Date()): string {
  const ms = now.getTime() - n * 24 * 60 * 60 * 1000;
  return stockholmDateKey(new Date(ms));
}

/**
 * Compute Stockholm date N days from now (YYYY-MM-DD).
 */
function stockholmDateNDaysAhead(n: number, now: Date = new Date()): string {
  return stockholmDateNDaysAgo(-n, now);
}

export const handler = wrapHandler(
  async (_event: unknown): Promise<WeeklyReviewHandlerResult> => {
    await initSentry();
    await setupOtelTracingAsync();

    const ownerId = process.env.KEVIN_OWNER_ID;
    if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

    const captureId = ulid();
    tagTraceWithCaptureId(captureId);

    try {
      const pool = await getPool();

      const claimed = await insertAgentRunStarted(pool, {
        captureId,
        ownerId,
        agentName: 'weekly-review',
      });
      if (!claimed) {
        return { skipped: 'duplicate' };
      }

      try {
        const todayStockholm = stockholmDateKey();
        // Inclusive 7-day window ending today: weekStart = today - 6 days.
        const weekStart = stockholmDateNDaysAgo(6);
        // Exclusive end for half-open SQL ranges = tomorrow.
        const weekEndExclusive = stockholmDateNDaysAhead(1);

        // Step 1: parallel hot entities + week recap hint.
        const [hot, recap] = await Promise.all([
          loadHotEntities(pool, ownerId, 7, 20),
          loadWeekRecapHint(pool, ownerId, weekStart, weekEndExclusive),
        ]);
        const entityIds = hot.map((h) => h.entity_id);

        // Step 2: loadContext with the hot-entity IDs.
        const ctx = await loadContext({
          entityIds,
          agentName: 'weekly-review',
          captureId,
          ownerId,
          pool,
          azureSearch: ({ rawText, entityIds: eids, topK }) =>
            hybridQuery({ rawText, entityIds: eids, topK }).then((r) => r.hits),
        });

        // Step 3: pre-render hints.
        const recapSummary =
          recap.length === 0
            ? '(week recap hint unavailable — Phase 4 schema not yet present)'
            : recap.map((r) => `- ${r.kind}: ${r.n}`).join('\n');
        const activeThreadsSummary = ctx.kevin_context.active_deals?.trim() || '(no active deals recorded yet)';

        // Step 4: invoke Sonnet 4.6 with tool_use.
        const agentResult = await runWeeklyReviewAgent({
          kevinContextBlock: renderKevinContextString(ctx.kevin_context),
          assembledMarkdown: ctx.assembled_markdown,
          weekRecapHint: recapSummary,
          activeThreadsHint: activeThreadsSummary,
          weekStartStockholm: weekStart,
          weekEndStockholm: todayStockholm,
          ownerId,
        });

        // Step 5: render artifacts (no top3_membership writes — D-05).
        const dailyLogDbId = process.env.NOTION_DAILY_BRIEF_LOG_DB_ID;
        const kevinContextPageId = process.env.NOTION_KEVIN_CONTEXT_PAGE_ID;
        if (!dailyLogDbId || !kevinContextPageId) {
          throw new Error(
            'NOTION_DAILY_BRIEF_LOG_DB_ID / NOTION_KEVIN_CONTEXT_PAGE_ID unset — operator must seed scripts/.notion-db-ids.json before deploy.',
          );
        }
        const logRequest = renderDailyBriefLogPage(agentResult.output, {
          databaseId: dailyLogDbId,
          dateStockholm: todayStockholm,
          briefKind: 'weekly-review',
          dashUrl: process.env.DASH_URL,
        });
        const html = renderTelegramHtml(agentResult.output, {
          briefKind: 'weekly-review',
          dateStockholm: todayStockholm,
          dashUrl: process.env.DASH_URL,
        });

        // Step 6: parallel Notion writes — best-effort. Active Threads
        // section overwrite is the must-have side-effect for AUTO-04.
        const [activeThreadsResult, notionLogResult] = await Promise.allSettled([
          replaceActiveThreadsSection(kevinContextPageId, agentResult.output.active_threads_snapshot),
          appendDailyBriefLogPage(logRequest),
        ]);
        if (activeThreadsResult.status === 'rejected') {
          console.warn('[weekly-review] Active Threads section replace failed (best-effort):', activeThreadsResult.reason);
        }
        if (notionLogResult.status === 'rejected') {
          console.warn('[weekly-review] Daily Brief Log append failed (best-effort):', notionLogResult.reason);
        }

        // Step 7: emit ONE output.push to kos.output (Sunday 1-of-3 cap).
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: process.env.OUTPUT_BUS_NAME ?? 'kos.output',
                Source: 'kos.output',
                DetailType: 'output.push',
                Detail: JSON.stringify({
                  capture_id: captureId,
                  body: html,
                  is_reply: false,
                  // Fix 2026-04-28: forward Kevin's chat_id so push-telegram
                  // has a target. Without this the Lambda throws "invoked
                  // without telegram.chat_id" (observed 3x in 24h).
                  ...(process.env.KEVIN_TELEGRAM_CHAT_ID
                    ? {
                        telegram: {
                          chat_id: Number(process.env.KEVIN_TELEGRAM_CHAT_ID),
                        },
                      }
                    : {}),
                }),
              },
            ],
          }),
        );

        // Step 8: persist agent_runs success.
        await updateAgentRunSuccess(
          pool,
          captureId,
          {
            brief_kind: 'weekly-review',
            brief_capture_id: captureId,
            rendered_at: new Date().toISOString(),
            data: agentResult.output,
          },
          agentResult.usage,
        );

        return {
          brief_capture_id: captureId,
          week_recap_count: agentResult.output.week_recap.length,
          next_week_count: agentResult.output.next_week_candidates.length,
          active_threads_status: activeThreadsResult.status,
          notion_log_status: notionLogResult.status,
        };
      } catch (err) {
        await updateAgentRunError(pool, captureId, err as Error).catch(() => {
          /* swallow — error path must not throw */
        });
        try {
          await eb.send(
            new PutEventsCommand({
              Entries: [
                {
                  EventBusName: process.env.SYSTEM_BUS_NAME ?? 'kos.system',
                  Source: 'kos.system',
                  DetailType: 'brief.generation_failed',
                  Detail: JSON.stringify({
                    capture_id: captureId,
                    brief_kind: 'weekly-review',
                    error: String((err as Error).message ?? err),
                  }),
                },
              ],
            }),
          );
        } catch {
          /* swallow — operator alarm best-effort */
        }
        return {
          status: 'error',
          brief_capture_id: captureId,
          error: String((err as Error).message ?? err),
        };
      }
    } finally {
      await langfuseFlush();
    }
  },
);

function renderKevinContextString(
  kc: {
    current_priorities: string;
    active_deals: string;
    whos_who: string;
    blocked_on: string;
    recent_decisions: string;
    open_questions: string;
    last_updated: string | null;
  },
): string {
  const sections: string[] = [];
  if (kc.current_priorities && kc.current_priorities.trim()) {
    sections.push(`## Current priorities\n${kc.current_priorities}`);
  }
  if (kc.active_deals && kc.active_deals.trim()) {
    sections.push(`## Active deals\n${kc.active_deals}`);
  }
  if (kc.whos_who && kc.whos_who.trim()) {
    sections.push(`## Who's who\n${kc.whos_who}`);
  }
  if (kc.blocked_on && kc.blocked_on.trim()) {
    sections.push(`## Blocked on\n${kc.blocked_on}`);
  }
  if (kc.recent_decisions && kc.recent_decisions.trim()) {
    sections.push(`## Recent decisions\n${kc.recent_decisions}`);
  }
  if (kc.open_questions && kc.open_questions.trim()) {
    sections.push(`## Open questions\n${kc.open_questions}`);
  }
  return sections.length > 0
    ? `# Kevin Context\n\n${sections.join('\n\n')}`
    : '';
}
