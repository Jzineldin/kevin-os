/**
 * Phase 7 Plan 07-02 — weekly-review Sonnet 4.6 agent.
 *
 * Single Bedrock invocation forced via tool_choice='record_weekly_review'.
 * Mirrors morning-brief / day-close shape; only the schema, prompt, and tool
 * name differ.
 *
 * On Zod parse failure or no tool_use block → safe fallback review (empty
 * arrays + "failed" prose marker). The handler emits
 * kos.system / brief.generation_failed for operator visibility.
 *
 * 3 system-prompt segments (BASE + Kevin Context + dossier markdown), all
 * cache_control:ephemeral. Sunday weekly is a single fire so cache reuse is
 * unlikely — segments are still tagged for consistency with the other briefs.
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { WeeklyReviewSchema, type WeeklyReview } from '@kos/contracts';

let client: AnthropicBedrock | null = null;
function getClient(): AnthropicBedrock {
  if (!client) {
    client = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return client;
}

export const SONNET_4_6_MODEL_ID = 'eu.anthropic.claude-sonnet-4-6-20250929-v1:0';

export const WEEKLY_REVIEW_BASE_PROMPT = `# Role
You are KOS Weekly Review agent for Kevin — Sunday 19:00 retrospective. Calm, prose-first, no emoji fatigue.

Kevin runs Tale Forge AB (Swedish EdTech, AI storytelling for children) and is CTO Outbehaving. ADHD founder. Native Swedish speaker; bilingual SE/EN.

# Job (Sunday 19:00)
1. 5-8 sentence prose summary of the week (calm, prose-first; Swedish or English to match Kevin's mode). ≤ 1000 chars.
2. Week recap: 5-10 bullet highlights (each ≤ 240 chars).
3. Next week candidates: 3-7 things Kevin should consider doing — title + why (each ≤ 200 chars).
4. Active threads snapshot: current state of every active deal/partnership/project.
   Allowed bolag (\`where\`): almi, speed, tale-forge, outbehaving, other.

# Rules
- NO bullet-point walls of text in the prose summary.
- NO emojis beyond at most one per section header.
- Direct, calm tone — no "what a week!" openers.
- Active threads = real moving pieces; if no movement, leave list short.

# Output
Call tool \`record_weekly_review\` EXACTLY ONCE with the structured schema. DO NOT respond with free-form text.
`;

export const RECORD_WEEKLY_REVIEW_TOOL = {
  name: 'record_weekly_review',
  description:
    'Record the structured weekly review (prose summary, week recap, next-week candidates, active threads snapshot).',
  input_schema: {
    type: 'object',
    properties: {
      prose_summary: { type: 'string', minLength: 1, maxLength: 1000 },
      week_recap: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 240 },
      },
      next_week_candidates: {
        type: 'array',
        maxItems: 7,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            why: { type: 'string', minLength: 1, maxLength: 200 },
          },
          required: ['title', 'why'],
        },
      },
      active_threads_snapshot: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            thread: { type: 'string', minLength: 1, maxLength: 200 },
            where: {
              type: 'string',
              enum: ['almi', 'speed', 'tale-forge', 'outbehaving', 'other'],
            },
            status: { type: 'string', maxLength: 200 },
          },
          required: ['thread', 'where', 'status'],
        },
      },
    },
    required: [
      'prose_summary',
      'week_recap',
      'next_week_candidates',
      'active_threads_snapshot',
    ],
  },
} as const;

export interface WeeklyReviewAgentInput {
  kevinContextBlock: string;
  assembledMarkdown: string;
  weekRecapHint: string;
  activeThreadsHint: string;
  weekStartStockholm: string;
  weekEndStockholm: string;
  ownerId: string;
}

export interface WeeklyReviewUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface WeeklyReviewAgentResult {
  output: WeeklyReview;
  usage: WeeklyReviewUsage;
  rawText: string;
}

function fallbackReview(reason: string): WeeklyReview {
  return {
    prose_summary: `Weekly review generation failed (${reason.slice(0, 200)}). See CloudWatch.`,
    week_recap: [],
    next_week_candidates: [],
    active_threads_snapshot: [],
  };
}

function buildUserPrompt(input: WeeklyReviewAgentInput): string {
  return [
    `Week ${input.weekStartStockholm} → ${input.weekEndStockholm} (Stockholm). Sunday retrospective.`,
    ``,
    `## Week recap hint (aggregated counts)`,
    input.weekRecapHint,
    ``,
    `## Current active threads (last known state)`,
    input.activeThreadsHint,
    ``,
    `Call record_weekly_review with the structured schema. Prose first, calm.`,
  ].join('\n');
}

export async function runWeeklyReviewAgent(
  input: WeeklyReviewAgentInput,
): Promise<WeeklyReviewAgentResult> {
  const system = [
    {
      type: 'text' as const,
      text: WEEKLY_REVIEW_BASE_PROMPT,
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: input.kevinContextBlock.trim() || '(Kevin Context unavailable)',
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: input.assembledMarkdown.trim() || '(No dossier context loaded)',
      cache_control: { type: 'ephemeral' as const },
    },
  ];

  const resp = await getClient().messages.create({
    model: SONNET_4_6_MODEL_ID,
    system: system as unknown as string,
    tools: [
      RECORD_WEEKLY_REVIEW_TOOL as unknown as Parameters<
        ReturnType<typeof getClient>['messages']['create']
      >[0]['tools'] extends (infer T)[] | undefined
        ? T
        : never,
    ],
    tool_choice: { type: 'tool', name: RECORD_WEEKLY_REVIEW_TOOL.name },
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    max_tokens: 4000,
  });

  const usage: WeeklyReviewUsage = {
    inputTokens: resp.usage?.input_tokens,
    outputTokens: resp.usage?.output_tokens,
    cacheReadInputTokens: (resp.usage as { cache_read_input_tokens?: number })
      ?.cache_read_input_tokens,
  };

  const toolBlock = resp.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === RECORD_WEEKLY_REVIEW_TOOL.name,
  );

  if (!toolBlock) {
    console.warn('[weekly-review] Sonnet returned no tool_use block', {
      contentTypes: resp.content.map((b) => b.type),
    });
    return {
      output: fallbackReview('no_tool_use'),
      usage,
      rawText: JSON.stringify(resp.content),
    };
  }

  const parsed = WeeklyReviewSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    console.warn('[weekly-review] Zod validation failed; returning safe fallback', {
      issues: parsed.error.issues.slice(0, 5),
      rawInput: toolBlock.input,
    });
    return {
      output: fallbackReview(
        'zod_invalid: ' +
          parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
      ),
      usage,
      rawText: JSON.stringify(toolBlock.input),
    };
  }

  return {
    output: parsed.data,
    usage,
    rawText: JSON.stringify(toolBlock.input),
  };
}

/** Test-only helper to reset the cached client between vitest cases. */
export function __resetAgentClientForTests(): void {
  client = null;
}
