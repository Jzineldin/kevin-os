/**
 * Phase 7 Plan 07-02 — day-close Lambda (AUTO-03).
 *
 * Fires Mon-Fri 18:00 Stockholm via EventBridge Scheduler. End-to-day flow:
 *
 *   1. initSentry + setupOtelTracingAsync
 *   2. Generate brief_capture_id := ulid()
 *   3. Idempotency claim — INSERT agent_runs status='started' if no prior ok row.
 *   4. Parallel loads:
 *        - loadHotEntities (top 10 by 12h mention count, D-17 day-close interval)
 *        - loadSlippedItemsForToday (morning Top 3 with NULL acted_on_at)
 *        - loadDecisionsHint (mention_events.context regex over last 12h)
 *   5. loadContext({ entityIds: hot, agentName: 'day-close', captureId, ownerId,
 *                    pool, azureSearch: hybridQuery wrapper }).
 *   6. runDayCloseAgent — Sonnet 4.6 tool_use → DayCloseBrief.
 *   7. writeTop3Membership (D-05: DayCloseBriefSchema HAS top_three).
 *   8. Notion side-effects via Promise.allSettled — best effort, in order:
 *        a. replaceTodayPageBlocks (🏠 Today)
 *        b. appendDailyBriefLogPage (Daily Brief Log DB row, Type=day-close)
 *        c. appendKevinContextSections (Recent decisions + Slipped items)
 *   9. Emit ONE output.push to kos.output (counts as 1-of-3 daily cap; weekday).
 *  10. updateAgentRunSuccess.
 *
 * Quiet-hours: 18:00 Stockholm is OUTSIDE the 20:00–08:00 window so D-18 doesn't
 * apply; push lands without queueing.
 *
 * On Bedrock failure: updateAgentRunError + emit kos.system / brief.generation_failed
 * (operator alarm via SafetyStack alarmTopic). Returns { status: 'error' }
 * WITHOUT throwing so EventBridge doesn't retry-storm.
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
  writeTop3Membership,
  loadHotEntities,
  loadSlippedItemsForToday,
  loadDecisionsHint,
} from './persist.js';
import { runDayCloseAgent } from './agent.js';
import {
  replaceTodayPageBlocks,
  appendDailyBriefLogPage,
  appendKevinContextSections,
} from './notion.js';
import {
  renderNotionTodayBlocks,
  renderDailyBriefLogPage,
  renderTelegramHtml,
  stockholmDateKey,
} from '../../_shared/brief-renderer.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

interface DayCloseHandlerSuccess {
  brief_capture_id: string;
  top3_count: number;
  slipped_count: number;
  notion_today_status: 'fulfilled' | 'rejected';
  notion_log_status: 'fulfilled' | 'rejected';
  kevin_context_status: 'fulfilled' | 'rejected';
}

interface DayCloseHandlerSkipped {
  skipped: 'duplicate';
}

interface DayCloseHandlerError {
  status: 'error';
  brief_capture_id: string;
  error: string;
}

type DayCloseHandlerResult =
  | DayCloseHandlerSuccess
  | DayCloseHandlerSkipped
  | DayCloseHandlerError;

export const handler = wrapHandler(
  async (_event: unknown): Promise<DayCloseHandlerResult> => {
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
        agentName: 'day-close',
      });
      if (!claimed) {
        return { skipped: 'duplicate' };
      }

      try {
        const dateStockholm = stockholmDateKey();

        // Step 1: hot entities (D-17 day-close uses 12h interval).
        const hot = await loadHotEntities(pool, ownerId, 12, 10);
        const entityIds = hot.map((h) => h.entity_id);

        // Step 2: parallel loadContext + slipped items + decisions hint.
        const [ctx, slipped, decisions] = await Promise.all([
          loadContext({
            entityIds,
            agentName: 'day-close',
            captureId,
            ownerId,
            pool,
            azureSearch: ({ rawText, entityIds: eids, topK }) =>
              hybridQuery({ rawText, entityIds: eids, topK }).then((r) => r.hits),
          }),
          loadSlippedItemsForToday(pool, ownerId, dateStockholm),
          loadDecisionsHint(pool, ownerId),
        ]);

        // Step 3: pre-render hints.
        const hotSummary =
          hot.length === 0
            ? '(no active entities in last 12h)'
            : hot.map((h) => `- ${h.name} (${h.mention_count} mentions, id=${h.entity_id})`).join('\n');
        const slippedSummary =
          slipped.length === 0
            ? '(no slipped items — morning Top 3 all received follow-up signal)'
            : slipped.map((s) => `- ${s.title} (urgency=${s.urgency}, id=${s.entity_id})`).join('\n');
        const decisionsSummary =
          decisions.length === 0
            ? '(no explicit decisions detected — Sonnet, infer from context)'
            : decisions
                .map((d) => `- ${d.occurred_at}: ${d.context.slice(0, 200)}`)
                .join('\n');

        // Step 4: invoke Sonnet 4.6 with tool_use.
        const agentResult = await runDayCloseAgent({
          kevinContextBlock: renderKevinContextString(ctx.kevin_context),
          assembledMarkdown: ctx.assembled_markdown,
          hotEntitiesSummary: hotSummary,
          slippedItemsHint: slippedSummary,
          decisionsHint: decisionsSummary,
          stockholmDate: dateStockholm,
          ownerId,
        });

        // Step 5: write top3_membership BEFORE outbound side-effects so a
        // crash between steps doesn't lose the durable record.
        await writeTop3Membership(pool, {
          ownerId,
          captureId,
          briefDateStockholm: dateStockholm,
          briefKind: 'day-close',
          topThree: agentResult.output.top_three,
        });

        // Step 6: render artifacts.
        const todayPageId = process.env.NOTION_TODAY_PAGE_ID;
        const dailyLogDbId = process.env.NOTION_DAILY_BRIEF_LOG_DB_ID;
        const kevinContextPageId = process.env.NOTION_KEVIN_CONTEXT_PAGE_ID;
        if (!todayPageId || !dailyLogDbId || !kevinContextPageId) {
          throw new Error(
            'NOTION_TODAY_PAGE_ID / NOTION_DAILY_BRIEF_LOG_DB_ID / NOTION_KEVIN_CONTEXT_PAGE_ID unset — operator must seed scripts/.notion-db-ids.json before deploy.',
          );
        }
        const blocks = renderNotionTodayBlocks(agentResult.output, {
          dashUrl: process.env.DASH_URL,
        });
        const logRequest = renderDailyBriefLogPage(agentResult.output, {
          databaseId: dailyLogDbId,
          dateStockholm,
          briefKind: 'day-close',
          dashUrl: process.env.DASH_URL,
        });
        const html = renderTelegramHtml(agentResult.output, {
          briefKind: 'day-close',
          dateStockholm,
          dashUrl: process.env.DASH_URL,
        });

        // Step 7: parallel Notion writes — best-effort. If 🏠 Today fails
        // the Daily Brief Log + Kevin Context appends still proceed; if any
        // single Notion call fails, Telegram push still fires.
        const [notionTodayResult, notionLogResult, kevinContextResult] = await Promise.allSettled([
          replaceTodayPageBlocks(todayPageId, blocks),
          appendDailyBriefLogPage(logRequest),
          appendKevinContextSections(kevinContextPageId, {
            recentDecisions: agentResult.output.recent_decisions,
            slippedItems: agentResult.output.slipped_items.map((s) => ({
              title: s.title,
              reason: s.reason,
            })),
            date: dateStockholm,
          }),
        ]);
        if (notionTodayResult.status === 'rejected') {
          console.warn('[day-close] Notion 🏠 Today replace failed (best-effort):', notionTodayResult.reason);
        }
        if (notionLogResult.status === 'rejected') {
          console.warn('[day-close] Daily Brief Log append failed (best-effort):', notionLogResult.reason);
        }
        if (kevinContextResult.status === 'rejected') {
          console.warn('[day-close] Kevin Context append failed (best-effort):', kevinContextResult.reason);
        }

        // Step 8: emit ONE output.push to kos.output.
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

        // Step 9: persist agent_runs success.
        await updateAgentRunSuccess(
          pool,
          captureId,
          {
            brief_kind: 'day-close',
            brief_capture_id: captureId,
            rendered_at: new Date().toISOString(),
            data: agentResult.output,
          },
          agentResult.usage,
        );

        return {
          brief_capture_id: captureId,
          top3_count: agentResult.output.top_three.length,
          slipped_count: agentResult.output.slipped_items.length,
          notion_today_status: notionTodayResult.status,
          notion_log_status: notionLogResult.status,
          kevin_context_status: kevinContextResult.status,
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
                    brief_kind: 'day-close',
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

/**
 * Format the Phase 6 Kevin Context bundle as a markdown block for the agent
 * prompt. Empty sections are omitted (calm by default). Mirrors the
 * morning-brief implementation; duplicated here so day-close is independently
 * inspectable.
 */
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
