/**
 * On-demand email draft generator — Sonnet 4.6 via Bedrock.
 *
 * Called by POST /email-drafts/:id/draft when Kevin wants to reply to an
 * email the triage agent had skipped (informational / junk). The email
 * body is already persisted (migration 0024) so we pass it to Sonnet
 * alongside Kevin's intent + optional freeform note.
 *
 * Intent shapes:
 *   - 'quick'    → 2-3 sentence reply, warm but brief
 *   - 'detailed' → longer reply addressing the email's substance
 *   - 'decline'  → polite no-thanks, no explanation required
 *
 * The reply is written in the language of the incoming email (Swedish
 * if Swedish, English otherwise). Signatures are NOT appended; Gmail
 * will add Kevin's own signature at send time.
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { z } from 'zod';

const SONNET_4_6_MODEL_ID = 'eu.anthropic.claude-sonnet-4-6';

let bedrock: AnthropicBedrock | null = null;
function getBedrock(): AnthropicBedrock {
  if (!bedrock) {
    bedrock = new AnthropicBedrock({
      awsRegion:
        process.env.AWS_REGION_DASHBOARD ??
        process.env.AWS_REGION ??
        'eu-north-1',
    });
  }
  return bedrock;
}

export interface DraftWithBedrockInput {
  fromEmail: string;
  toEmail: string[];
  subject: string;
  bodyPlain: string;
  intent: 'quick' | 'detailed' | 'decline';
  kevinNote?: string;
}

export interface DraftResult {
  subject: string;
  body: string;
}

const ResultSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(10_000),
});

const SYSTEM_PROMPT = `You are KOS Draft Writer — drafting an email reply on Kevin's behalf.

# Who Kevin is
Kevin El-zarka, runs Tale Forge AB (Swedish EdTech) as CEO and is CTO of Outbehaving. Bilingual SE/EN.

# Rules
- Reply in the language of the incoming email. If the original is Swedish, reply in Swedish; if English, reply in English. Match formality level.
- NEVER fabricate facts, numbers, deadlines, or commitments Kevin didn't confirm. If the reply requires a decision Kevin hasn't made, say so ("Kevin will confirm by Friday" not "Yes, let's do X").
- DO NOT add a signature block — Gmail inserts Kevin's own signature at send time.
- DO NOT add "Hope this email finds you well" or similar padding. Direct, warm, professional.
- Use "Kevin" for Swedish emails (first name only). English emails can use "Kevin" or "Kevin El-zarka" depending on context.

# Intent shaping
- quick     — 2-3 sentences max. Acknowledge + one concrete next action.
- detailed  — 4-8 sentences. Address the substance, show reasoning, propose a concrete next step.
- decline   — 2-3 sentences. Polite decline, no over-explanation. No "unfortunately" — just clear decline + brief reason.

# Output
Use the record_draft tool EXACTLY ONCE with the full reply.`;

const TOOL_DEF = {
  name: 'record_draft',
  description: 'Record the drafted email reply Kevin will review before sending.',
  input_schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Reply subject line. If the original is not already "Re:"-prefixed, prepend "Re: ".',
      },
      body: {
        type: 'string',
        description: 'Full reply body, plain text. No signature block.',
      },
    },
    required: ['subject', 'body'],
  },
};

export async function draftWithBedrock(
  input: DraftWithBedrockInput,
): Promise<DraftResult> {
  const userPrompt = `Original email to reply to:

FROM: ${input.fromEmail}
TO: ${input.toEmail.join(', ')}
SUBJECT: ${input.subject}

BODY:
${input.bodyPlain.slice(0, 8000)}

---

Intent: ${input.intent}${input.kevinNote ? `\n\nKevin's note (must respect): ${input.kevinNote}` : ''}

Draft the reply now. Call record_draft with subject + body.`;

  const res = await getBedrock().messages.create({
    model: SONNET_4_6_MODEL_ID,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEF] as unknown as Parameters<
      ReturnType<typeof getBedrock>['messages']['create']
    >[0]['tools'],
    tool_choice: { type: 'tool', name: 'record_draft' } as unknown as Parameters<
      ReturnType<typeof getBedrock>['messages']['create']
    >[0]['tool_choice'],
    messages: [{ role: 'user', content: userPrompt }],
  });
  for (const block of res.content) {
    if (block.type === 'tool_use' && block.name === 'record_draft') {
      const parsed = ResultSchema.safeParse(block.input);
      if (!parsed.success) {
        throw new Error(
          `draft tool output failed validation: ${parsed.error.issues
            .map((i) => i.message)
            .join('; ')}`,
        );
      }
      return parsed.data;
    }
  }
  throw new Error('Bedrock did not produce a tool_use block for record_draft');
}
