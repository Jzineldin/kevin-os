/**
 * Phase 7 Plan 07-02 — day-close Sonnet 4.6 agent.
 *
 * Single Bedrock invocation forced via tool_choice='record_day_close_brief'.
 * Mirrors services/morning-brief/src/agent.ts shape; only the schema, prompt,
 * and tool name differ.
 *
 * On Zod parse failure or no tool_use block → safe fallback brief (empty
 * arrays + "failed" prose marker). The handler emits
 * kos.system / brief.generation_failed for operator visibility.
 *
 * Cost mitigation: 3 system-prompt segments (BASE + Kevin Context + dossier
 * markdown) all cache_control:ephemeral so consecutive briefs (morning at 08:00,
 * day-close at 18:00) hit the 5-min Bedrock prompt cache when the dossier
 * snapshot is unchanged.
 *
 * EU inference profile: eu.anthropic.claude-sonnet-4-6
 * (matches morning-brief; the Phase 6 SDK update aligned model IDs).
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { DayCloseBriefSchema, type DayCloseBrief } from '@kos/contracts';

let client: AnthropicBedrock | null = null;
function getClient(): AnthropicBedrock {
  if (!client) {
    client = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'eu-north-1',
    });
  }
  return client;
}

export const SONNET_4_6_MODEL_ID = 'eu.anthropic.claude-sonnet-4-6';

export const DAY_CLOSE_BASE_PROMPT = `# Role
You are KOS Day Close agent for Kevin — calm end-of-day reflection. Prose-first, zero emoji fatigue.

Kevin runs Tale Forge AB (Swedish EdTech, AI storytelling for children) and is CTO Outbehaving. ADHD founder. Native Swedish speaker; works bilingually SE/EN.

# Job (end-of-day, 18:00 Stockholm)
1. 3-5 sentence prose summary of today (calm, prose-first; Swedish or English to match Kevin's recent mode). ≤ 600 chars.
2. Top 3 carryover — items from this morning that are STILL pending and should roll into tomorrow. NOT new items. Each title ≤ 200 chars; entity_ids drawn from hot entities.
3. Slipped items: today's morning Top 3 entries with no signal of action. Pull from "Slipped items hint" section.
4. Recent decisions: explicit decisions made today (extracted from captures + transcripts + emails). Pull from "Decisions hint" section. Each ≤ 200 chars; max 5.
5. Active threads delta: which threads moved (new / updated / closed) — max 10.

# Rules
- NO bullet-point walls of text. Prose first.
- NO emojis beyond at most one per section header.
- NO "winding down" openers. Direct.
- Empty arrays are fine — calm by default.

# Output
Call tool \`record_day_close_brief\` EXACTLY ONCE with the structured schema. DO NOT respond with free-form text.
`;

// JSON schema mirrors DayCloseBriefSchema (packages/contracts/src/brief.ts).
// Hand-written for Bedrock; any change here MUST be reflected in
// DayCloseBriefSchema or Zod parse will reject perfectly-shaped tool output.
export const RECORD_DAY_CLOSE_TOOL = {
  name: 'record_day_close_brief',
  description:
    'Record the structured day-close brief (prose summary, Top 3 carryover, slipped items, recent decisions, active threads delta).',
  input_schema: {
    type: 'object',
    properties: {
      prose_summary: { type: 'string', minLength: 1, maxLength: 600 },
      top_three: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            entity_ids: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            urgency: { type: 'string', enum: ['high', 'med', 'low'] },
          },
          required: ['title', 'entity_ids', 'urgency'],
        },
      },
      dropped_threads: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            entity_ids: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            last_mentioned_at: { type: 'string' },
          },
          required: ['title', 'entity_ids'],
        },
      },
      slipped_items: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            entity_ids: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            reason: { type: 'string', maxLength: 200 },
          },
          required: ['title', 'entity_ids'],
        },
      },
      recent_decisions: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string', maxLength: 200 },
      },
      active_threads_delta: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            thread: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['new', 'updated', 'closed'] },
          },
          required: ['thread', 'status'],
        },
      },
    },
    required: [
      'prose_summary',
      'top_three',
      'dropped_threads',
      'slipped_items',
      'recent_decisions',
      'active_threads_delta',
    ],
  },
} as const;

export interface DayCloseAgentInput {
  kevinContextBlock: string;
  assembledMarkdown: string;
  hotEntitiesSummary: string;
  slippedItemsHint: string;
  decisionsHint: string;
  stockholmDate: string;
  ownerId: string;
}

export interface DayCloseUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface DayCloseAgentResult {
  output: DayCloseBrief;
  usage: DayCloseUsage;
  rawText: string;
}

/**
 * Safe-fallback brief used when Sonnet returns no tool_use or fails Zod
 * validation. Lets the handler complete the run without crashing the
 * EventBridge invocation. The handler emits kos.system / brief.generation_failed
 * so operator alarms still fire.
 */
function fallbackBrief(reason: string): DayCloseBrief {
  return {
    prose_summary: `Day close generation failed (${reason.slice(0, 200)}). See CloudWatch.`,
    top_three: [],
    dropped_threads: [],
    slipped_items: [],
    recent_decisions: [],
    active_threads_delta: [],
  };
}

function buildUserPrompt(input: DayCloseAgentInput): string {
  return [
    `Today is ${input.stockholmDate} (Stockholm). End-of-day reflection.`,
    ``,
    `## Hot entities (last 12h)`,
    input.hotEntitiesSummary,
    ``,
    `## Slipped items hint (this morning's Top 3 with no follow-up signal)`,
    input.slippedItemsHint,
    ``,
    `## Decisions hint (mentions/captures matching decided|approved|signed|agreed in last 12h)`,
    input.decisionsHint,
    ``,
    `Call record_day_close_brief with the structured schema. Prose first, calm.`,
  ].join('\n');
}

export async function runDayCloseAgent(
  input: DayCloseAgentInput,
): Promise<DayCloseAgentResult> {
  // 3 system segments per plan: BASE + Kevin Context + assembled dossier
  // markdown. All cache_control:ephemeral so consecutive briefs hit the
  // 5-min Bedrock prompt cache.
  const system = [
    {
      type: 'text' as const,
      text: DAY_CLOSE_BASE_PROMPT,
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
      RECORD_DAY_CLOSE_TOOL as unknown as Parameters<
        ReturnType<typeof getClient>['messages']['create']
      >[0]['tools'] extends (infer T)[] | undefined
        ? T
        : never,
    ],
    tool_choice: { type: 'tool', name: RECORD_DAY_CLOSE_TOOL.name },
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    max_tokens: 4000,
  });

  const usage: DayCloseUsage = {
    inputTokens: resp.usage?.input_tokens,
    outputTokens: resp.usage?.output_tokens,
    cacheReadInputTokens: (resp.usage as { cache_read_input_tokens?: number })
      ?.cache_read_input_tokens,
  };

  const toolBlock = resp.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === RECORD_DAY_CLOSE_TOOL.name,
  );

  if (!toolBlock) {
    console.warn('[day-close] Sonnet returned no tool_use block', {
      contentTypes: resp.content.map((b) => b.type),
    });
    return {
      output: fallbackBrief('no_tool_use'),
      usage,
      rawText: JSON.stringify(resp.content),
    };
  }

  const parsed = DayCloseBriefSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    console.warn('[day-close] Zod validation failed; returning safe fallback', {
      issues: parsed.error.issues.slice(0, 5),
      rawInput: toolBlock.input,
    });
    return {
      output: fallbackBrief(
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
