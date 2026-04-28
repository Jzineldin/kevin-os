/**
 * Phase 7 Plan 07-01 — morning-brief Lambda (AUTO-01).
 *
 * Fires Mon-Fri 08:00 Stockholm via EventBridge Scheduler. End-to-end flow:
 *
 *   1. initSentry + setupOtelTracingAsync
 *   2. Generate brief_capture_id := ulid()
 *   3. Idempotency claim — INSERT agent_runs status='started' if no prior ok row.
 *   4. Parallel: loadHotEntities (top 10 by 48h mention count) +
 *                loadDraftsReady + loadDroppedThreads.
 *   5. loadContext({ entityIds: hot, agentName, captureId, ownerId,
 *                    pool, azureSearch: hybridQuery wrapper }) — Phase 6 wiring.
 *   6. runMorningBriefAgent — Sonnet 4.6 tool_use → MorningBrief.
 *   7. writeTop3Membership — durable side-effect BEFORE Notion / Telegram.
 *   8. Notion 🏠 Today replace-in-place + Daily Brief Log append (Promise.allSettled — best effort).
 *   9. Emit ONE output.push to kos.output (counts as 1-of-3 daily cap).
 *  10. updateAgentRunSuccess.
 *
 * On Bedrock failure: updateAgentRunError + emit kos.system / brief.generation_failed
 * (operator alarm via SafetyStack alarmTopic). Returns { status: 'error' }
 * WITHOUT throwing so EventBridge doesn't retry-storm.
 *
 * Quiet-hours: D-18 — schedule is 08:00 (NOT 07:00) so push-telegram's
 * `isQuietHour` check passes cleanly. The output.push event fires after the
 * 20:00–08:00 window closes.
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
  writeBriefProposals,
  loadDraftsReady,
  loadDroppedThreads,
} from './persist.js';
import { loadHotEntities } from './hot-entities.js';
import { runMorningBriefAgent } from './agent.js';
import { replaceTodayPageBlocks, appendDailyBriefLogPage } from './notion.js';
import {
  renderNotionTodayBlocks,
  renderDailyBriefLogPage,
  renderTelegramHtml,
  stockholmDateKey,
} from '../../_shared/brief-renderer.js';

if (!process.env.AWS_REGION) process.env.AWS_REGION = 'eu-north-1';

const eb = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

interface MorningBriefHandlerSuccess {
  brief_capture_id: string;
  top3_count: number;
  dropped_threads_count: number;
  notion_today_status: 'fulfilled' | 'rejected';
  notion_log_status: 'fulfilled' | 'rejected';
}

interface MorningBriefHandlerSkipped {
  skipped: 'duplicate';
}

interface MorningBriefHandlerError {
  status: 'error';
  brief_capture_id: string;
  error: string;
}

type MorningBriefHandlerResult =
  | MorningBriefHandlerSuccess
  | MorningBriefHandlerSkipped
  | MorningBriefHandlerError;

export const handler = wrapHandler(
  async (_event: unknown): Promise<MorningBriefHandlerResult> => {
    await initSentry();
    await setupOtelTracingAsync();

    const ownerId = process.env.KEVIN_OWNER_ID;
    if (!ownerId) throw new Error('KEVIN_OWNER_ID not set');

    const captureId = ulid();
    tagTraceWithCaptureId(captureId);

    try {
      const pool = await getPool();

      // Idempotency claim.
      const claimed = await insertAgentRunStarted(pool, {
        captureId,
        ownerId,
        agentName: 'morning-brief',
      });
      if (!claimed) {
        return { skipped: 'duplicate' };
      }

      try {
        const dateStockholm = stockholmDateKey();

        // Step 1: hot entities — D-17 top-10 by 48h mention count.
        const hot = await loadHotEntities(pool, ownerId, 48, 10);
        const entityIds = hot.map((h) => h.entity_id);

        // Step 2: parallel loadContext + drafts + dropped threads.
        const [ctx, draftsReady, dropped] = await Promise.all([
          loadContext({
            entityIds,
            agentName: 'morning-brief',
            captureId,
            ownerId,
            pool,
            azureSearch: ({ rawText, entityIds: eids, topK }) =>
              hybridQuery({ rawText, entityIds: eids, topK }).then((r) => r.hits),
          }),
          loadDraftsReady(pool, ownerId, 10),
          loadDroppedThreads(pool, ownerId),
        ]);

        // Step 3: pre-render context summaries for the user prompt.
        const hotSummary =
          hot.length === 0
            ? '(no active entities in last 48h)'
            : hot.map((h) => `- ${h.name} (${h.mention_count} mentions, id=${h.entity_id})`).join('\n');
        const draftsSummary =
          draftsReady.length === 0
            ? '(no drafts awaiting approval)'
            : draftsReady
                .map(
                  (d) =>
                    `- ${d.classification.toUpperCase()} · from ${d.from} · ${d.subject} (id=${d.draft_id})`,
                )
                .join('\n');
        const droppedSummary =
          dropped.length === 0
            ? '(no dropped threads)'
            : dropped.map((d) => `- ${d.title}`).join('\n');

        // Step 4: invoke Sonnet 4.6 with tool_use.
        const agentResult = await runMorningBriefAgent({
          kevinContextBlock: renderKevinContextString(ctx.kevin_context),
          assembledMarkdown: `${ctx.assembled_markdown}\n\n## Dropped threads from prior briefs\n${droppedSummary}`,
          hotEntitiesSummary: hotSummary,
          draftsReadySummary: draftsSummary,
          calendarHint: '(Calendar integration pending Phase 8)',
          stockholmDate: dateStockholm,
          ownerId,
        });

        // Step 5: write top3_membership BEFORE outbound side-effects so a
        // crash between steps doesn't lose the durable record.
        await writeTop3Membership(pool, {
          ownerId,
          captureId,
          briefDateStockholm: dateStockholm,
          briefKind: 'morning-brief',
          topThree: agentResult.output.top_three,
        });

        // Phase 11 Plan 11-05: also write review-gated proposals so Kevin
        // can accept/reject/replace each Top 3 item via the dashboard
        // inbox. Fully non-fatal: any error here is swallowed so the
        // brief's primary path (top3_membership + Notion + Telegram)
        // is never impacted.
        try {
          const proposalBatchId = await writeBriefProposals(pool, {
            ownerId,
            captureId,
            briefKind: 'morning-brief',
            topThree: agentResult.output.top_three,
          });
          if (proposalBatchId) {
            console.log(
              `[morning-brief] proposals batch=${proposalBatchId} items=${agentResult.output.top_three.length}`,
            );
          }
        } catch (err) {
          console.warn('[morning-brief] proposal dual-write errored (non-fatal):', err);
        }

        // Step 6: render artifacts.
        const todayPageId = process.env.NOTION_TODAY_PAGE_ID;
        const dailyLogDbId = process.env.NOTION_DAILY_BRIEF_LOG_DB_ID;
        if (!todayPageId || !dailyLogDbId) {
          throw new Error(
            'NOTION_TODAY_PAGE_ID / NOTION_DAILY_BRIEF_LOG_DB_ID unset — operator must seed scripts/.notion-db-ids.json before deploy (todayPage + dailyBriefLog).',
          );
        }
        const blocks = renderNotionTodayBlocks(agentResult.output, {
          dashUrl: process.env.DASH_URL,
        });
        const logRequest = renderDailyBriefLogPage(agentResult.output, {
          databaseId: dailyLogDbId,
          dateStockholm,
          briefKind: 'morning-brief',
          dashUrl: process.env.DASH_URL,
        });
        const html = renderTelegramHtml(agentResult.output, {
          briefKind: 'morning-brief',
          dateStockholm,
          dashUrl: process.env.DASH_URL,
        });

        // Step 7: parallel Notion writes — best-effort. If 🏠 Today fails the
        // Daily Brief Log append still proceeds; if Daily Brief Log fails the
        // 🏠 Today replace still proceeds. Telegram push always fires.
        const [notionTodayResult, notionLogResult] = await Promise.allSettled([
          replaceTodayPageBlocks(todayPageId, blocks),
          appendDailyBriefLogPage(logRequest),
        ]);
        if (notionTodayResult.status === 'rejected') {
          console.warn('[morning-brief] Notion 🏠 Today replace failed (best-effort):', notionTodayResult.reason);
        }
        if (notionLogResult.status === 'rejected') {
          console.warn('[morning-brief] Daily Brief Log append failed (best-effort):', notionLogResult.reason);
        }

        // Step 8: emit ONE output.push to kos.output. Counts as 1-of-3 daily
        // cap; push-telegram applies cap + quiet-hours enforcement.
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
            brief_kind: 'morning-brief',
            brief_capture_id: captureId,
            rendered_at: new Date().toISOString(),
            data: agentResult.output,
          },
          agentResult.usage,
        );

        return {
          brief_capture_id: captureId,
          top3_count: agentResult.output.top_three.length,
          dropped_threads_count: agentResult.output.dropped_threads.length,
          notion_today_status: notionTodayResult.status,
          notion_log_status: notionLogResult.status,
        };
      } catch (err) {
        // Inner failure — write agent_runs error + emit kos.system event.
        // Also log the full stack so CloudWatch has something to bisect
        // on — the previous truncated `error: "Cannot read..."` messages
        // hid the actual line of code.
        console.error('[morning-brief] inner failure:', err instanceof Error ? err.stack : err);
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
                    brief_kind: 'morning-brief',
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
 * prompt. Empty sections are omitted (calm by default).
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
