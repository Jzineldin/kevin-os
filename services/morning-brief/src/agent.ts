/**
 * Phase 7 Plan 07-01 — morning-brief Sonnet 4.6 agent.
 *
 * Single Bedrock invocation forced via tool_choice='record_morning_brief'.
 * Mirrors services/transcript-extractor/src/agent.ts and
 * services/entity-resolver/src/disambig.ts patterns.
 *
 * On Zod parse failure or no tool_use block: returns a SAFE FALLBACK brief
 * (empty arrays + a "failed" prose marker). This keeps the handler hot path
 * crash-free; the failure path emits kos.system / brief.generation_failed
 * for operator visibility (handled by the handler).
 *
 * Cost mitigation: every system-prompt segment is cache_control:ephemeral
 * so the BASE prompt + Kevin Context + dossier markdown all benefit from
 * the 5-min Bedrock prompt cache.
 *
 * EU inference profile: eu.anthropic.claude-sonnet-4-6
 * (matches transcript-extractor; the Phase 6 SDK update aligned model IDs).
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { MorningBriefSchema, type MorningBrief } from '@kos/contracts';

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

export const MORNING_BRIEF_BASE_PROMPT = `# Role
You are KOS Morning Brief agent for Kevin — calm, prose-first, zero-emoji-fatigue.

Kevin runs Tale Forge AB (Swedish EdTech, AI storytelling for children) and is CTO Outbehaving. ADHD founder. Native Swedish speaker; works bilingually SE/EN.

# Job
1. Read Kevin Context + loaded dossiers + hot entities + drafts awaiting approval + dropped threads.
2. Produce a 3-5 sentence prose summary (Swedish or English — match Kevin's most-recent mode from context). ≤ 600 chars.
3. Pick Top 3 priorities for the day. Urgency: high|med|low. Each title ≤ 200 chars. Each item must include 1+ entity_id (UUID) drawn from the hot entities list when possible.
4. List drafts ready (urgent + important). Pull from "Drafts awaiting approval" section.
5. List dropped threads (unactioned items from prior Top 3). Pull from "Dropped threads from prior briefs" section.

# Rules
- NO bullet-point walls of text. Prose first.
- NO emojis beyond at most one per section header.
- NO "rise and shine" openers. Direct.
- Swedish-English code-switch OK if Kevin's context shows it.
- Calendar arrays: leave empty if no real calendar data is provided (Phase 8 wires real calendar).

# Output
Call tool \`record_morning_brief\` EXACTLY ONCE with the structured schema. DO NOT respond with free-form text.
`;

// JSON schema mirrors MorningBriefSchema (packages/contracts/src/brief.ts).
// Hand-written because Bedrock needs JSON Schema; any change here MUST be
// reflected in MorningBriefSchema or the Zod parse will reject perfectly-
// shaped tool output.
export const RECORD_MORNING_BRIEF_TOOL = {
  name: 'record_morning_brief',
  description:
    'Record the structured morning brief output for Kevin (prose summary, Top 3, dropped threads, calendar, drafts).',
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
      calendar_today: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            attendees: { type: 'array', items: { type: 'string' } },
          },
          required: ['start', 'title'],
        },
      },
      calendar_tomorrow: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            attendees: { type: 'array', items: { type: 'string' } },
          },
          required: ['start', 'title'],
        },
      },
      drafts_ready: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            draft_id: { type: 'string' },
            from: { type: 'string', minLength: 1, maxLength: 200 },
            subject: { type: 'string', minLength: 1, maxLength: 300 },
            classification: { type: 'string', enum: ['urgent', 'important'] },
          },
          required: ['draft_id', 'from', 'subject', 'classification'],
        },
      },
    },
    required: ['prose_summary', 'top_three', 'dropped_threads'],
  },
} as const;

export interface MorningBriefAgentInput {
  kevinContextBlock: string;
  assembledMarkdown: string;
  hotEntitiesSummary: string;
  draftsReadySummary: string;
  calendarHint: string;
  stockholmDate: string;
  ownerId: string;
}

export interface MorningBriefUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface MorningBriefAgentResult {
  output: MorningBrief;
  usage: MorningBriefUsage;
  rawText: string;
}

/**
 * Safe-fallback brief used when Sonnet returns no tool_use block or the
 * tool_use input fails Zod validation. Lets the handler complete the run
 * (best-effort Telegram + Notion + agent_runs persistence) without
 * crashing the EventBridge invocation. The handler ALSO emits a
 * kos.system / brief.generation_failed event so operator alarms fire.
 */
function fallbackBrief(reason: string): MorningBrief {
  return {
    prose_summary: `Brief generation failed (${reason.slice(0, 200)}). See CloudWatch.`,
    top_three: [],
    dropped_threads: [],
    calendar_today: [],
    calendar_tomorrow: [],
    drafts_ready: [],
  };
}

function buildUserPrompt(input: MorningBriefAgentInput): string {
  return [
    `Today is ${input.stockholmDate} (Stockholm).`,
    ``,
    `## Hot entities (last 48h)`,
    input.hotEntitiesSummary,
    ``,
    `## Drafts awaiting approval`,
    input.draftsReadySummary,
    ``,
    `## Calendar`,
    input.calendarHint,
    ``,
    `Call record_morning_brief with the structured schema. Prose first, calm.`,
  ].join('\n');
}

export async function runMorningBriefAgent(
  input: MorningBriefAgentInput,
): Promise<MorningBriefAgentResult> {
  // 3 system segments per plan: BASE + Kevin Context + assembled dossier
  // markdown. All cache_control:ephemeral so consecutive briefs hit the
  // 5-min Bedrock prompt cache. Empty segments are still emitted (test
  // requires exactly 3 segments) — Bedrock tolerates whitespace text.
  const system = [
    {
      type: 'text' as const,
      text: MORNING_BRIEF_BASE_PROMPT,
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
      RECORD_MORNING_BRIEF_TOOL as unknown as Parameters<
        ReturnType<typeof getClient>['messages']['create']
      >[0]['tools'] extends (infer T)[] | undefined
        ? T
        : never,
    ],
    tool_choice: { type: 'tool', name: RECORD_MORNING_BRIEF_TOOL.name },
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    max_tokens: 4000,
  });

  const usage: MorningBriefUsage = {
    inputTokens: resp.usage?.input_tokens,
    outputTokens: resp.usage?.output_tokens,
    cacheReadInputTokens: (resp.usage as { cache_read_input_tokens?: number })
      ?.cache_read_input_tokens,
  };

  const toolBlock = resp.content.find(
    (b): b is Extract<typeof b, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === RECORD_MORNING_BRIEF_TOOL.name,
  );

  if (!toolBlock) {
    console.warn('[morning-brief] Sonnet returned no tool_use block', {
      contentTypes: resp.content.map((b) => b.type),
    });
    return {
      output: fallbackBrief('no_tool_use'),
      usage,
      rawText: JSON.stringify(resp.content),
    };
  }

  const parsed = MorningBriefSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    console.warn('[morning-brief] Zod validation failed; returning safe fallback', {
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
