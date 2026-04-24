/**
 * handler.test.ts — transcript-extractor end-to-end handler tests
 * (Plan 06-02 Task 1).
 *
 * Coverage:
 *   1. Idempotency — prior agent_runs ok → short-circuit, no Bedrock call.
 *   2. detail-type != transcript.available → skipped early.
 *   3. Empty transcript body → skipped with reason='empty_transcript'.
 *   4. Happy path — 2 action_items + 3 mentions →
 *      • 2 Notion CC pages created
 *      • 3 mention_events INSERTed
 *      • 1 transcripts_indexed agent_runs row inserted
 *      • 3 entity.mention.detected EventBridge entries published
 *   5. tagTraceWithCaptureId is called with the transcript_id.
 *   6. Zod parse failure on event.detail throws (handled by wrapHandler).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const persistState = {
  prior: false,
  insertedRuns: [] as Array<{ ownerId: string; captureId: string; agentName: string }>,
  updatedRuns: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  mentionsWritten: 0,
  transcriptsIndexed: 0,
  publishedMentionsCount: 0,
};

vi.mock('../src/persist.js', () => ({
  getPool: vi.fn(async () => ({ query: vi.fn() })),
  findPriorOkRun: vi.fn(async () => persistState.prior),
  insertAgentRun: vi.fn(
    async (row: { ownerId: string; captureId: string; agentName: string; status: string }) => {
      persistState.insertedRuns.push({
        ownerId: row.ownerId,
        captureId: row.captureId,
        agentName: row.agentName,
      });
      return 'run-' + row.captureId;
    },
  ),
  updateAgentRun: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    persistState.updatedRuns.push({ id, patch });
  }),
  loadKevinContextBlockOnce: vi.fn(async () => '## Kevin Context\nFounder of Tale Forge.'),
  writeMentionEvents: vi.fn(async (input: { mentions: unknown[] }) => {
    persistState.mentionsWritten = input.mentions.length;
    return input.mentions.length;
  }),
  writeTranscriptIndexed: vi.fn(async () => {
    persistState.transcriptsIndexed += 1;
  }),
  publishMentionsDetected: vi.fn(async (input: { mentions: unknown[] }) => {
    persistState.publishedMentionsCount = input.mentions.length;
    return input.mentions.length;
  }),
  __resetForTests: vi.fn(),
}));

const ccCreatedPageIds = ['notion-page-1', 'notion-page-2'];
vi.mock('../src/notion.js', () => ({
  readTranscriptBody: vi.fn(async () => 'Möte om Almi konvertibellånet med Damien.'),
  writeActionItemsToCommandCenter: vi.fn(async (input: { items: unknown[] }) =>
    ccCreatedPageIds.slice(0, input.items.length),
  ),
}));

vi.mock('@notionhq/client', () => ({
  Client: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: 'secret-token' }),
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
}));

const agentExtract = {
  action_items: [
    {
      title: 'Ping Damien om konvertibellånet',
      priority: 'high' as const,
      due_hint: 'innan fredag',
      linked_entity_ids: [],
      source_excerpt: 'Kevin sa att han skulle pinga Damien.',
    },
    {
      title: 'Skicka recap-mail till Almi',
      priority: 'medium' as const,
      due_hint: null,
      linked_entity_ids: [],
      source_excerpt: 'Skicka recap.',
    },
  ],
  mentioned_entities: [
    {
      name: 'Damien',
      type: 'Person' as const,
      aliases: [],
      sentiment: 'neutral' as const,
      occurrence_count: 3,
      excerpt: 'Damien diskuterade lånet.',
    },
    {
      name: 'Almi Invest',
      type: 'Company' as const,
      aliases: ['Almi'],
      sentiment: 'positive' as const,
      occurrence_count: 5,
      excerpt: 'Almi Invest föreslog konvertibellån.',
    },
    {
      name: 'Tale Forge',
      type: 'Project' as const,
      aliases: [],
      sentiment: 'neutral' as const,
      occurrence_count: 2,
      excerpt: 'Tale Forge AB diskuterades.',
    },
  ],
  summary: 'Kevin och Damien diskuterade Almi konvertibellånet.',
  decisions: ['Skicka konvertibel inom veckan.'],
  open_questions: ['Vilken värdering ska vi sätta?'],
};

vi.mock('../src/agent.js', () => ({
  runExtractorAgent: vi.fn(async () => ({
    extract: agentExtract,
    usage: { inputTokens: 1500, outputTokens: 280 },
    rawToolInput: agentExtract,
    degraded: false,
  })),
}));

const tagSpy = vi.fn();
vi.mock('../../_shared/sentry.js', () => ({
  initSentry: vi.fn(async () => {}),
  wrapHandler: (h: unknown) => h,
  Sentry: { captureMessage: vi.fn(), captureException: vi.fn() },
}));
vi.mock('../../_shared/tracing.js', () => ({
  setupOtelTracing: vi.fn(),
  setupOtelTracingAsync: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  tagTraceWithCaptureId: tagSpy,
}));

const VALID_DETAIL = {
  capture_id: 'page-uuid-cap-001',
  owner_id: '00000000-0000-0000-0000-000000000001',
  transcript_id: 'page-uuid-cap-001',
  notion_page_id: 'page-uuid-cap-001',
  title: 'Almi follow-up',
  source: 'granola' as const,
  last_edited_time: '2026-04-22T10:00:00.000Z',
  raw_length: 12_000,
};

beforeEach(() => {
  persistState.prior = false;
  persistState.insertedRuns = [];
  persistState.updatedRuns = [];
  persistState.mentionsWritten = 0;
  persistState.transcriptsIndexed = 0;
  persistState.publishedMentionsCount = 0;
  tagSpy.mockClear();
  process.env.KEVIN_OWNER_ID = '00000000-0000-0000-0000-000000000001';
  process.env.NOTION_TOKEN = 'test-token';
  process.env.NOTION_COMMAND_CENTER_DB_ID = 'cc-db-id';
  process.env.KOS_AGENT_BUS_NAME = 'kos.agent';
  process.env.AWS_REGION = 'eu-north-1';
});

describe('transcript-extractor handler', () => {
  it('skips when detail-type != transcript.available', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'capture.received',
      detail: { foo: 'bar' },
    };
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)(event)) as {
      skipped?: string;
    };
    expect(result.skipped).toBe('capture.received');
    expect(persistState.insertedRuns).toHaveLength(0);
  });

  it('idempotent: prior agent_runs ok row → no work performed', async () => {
    persistState.prior = true;
    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'transcript.available',
      detail: VALID_DETAIL,
    };
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)(event)) as {
      idempotent?: string;
    };
    expect(result.idempotent).toBe(VALID_DETAIL.capture_id);
    expect(persistState.insertedRuns).toHaveLength(0);
    expect(persistState.mentionsWritten).toBe(0);
    expect(persistState.publishedMentionsCount).toBe(0);
  });

  it('happy path: 2 items + 3 mentions → 2 CC pages + 3 mentions written + 1 indexed + 3 published', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'transcript.available',
      detail: VALID_DETAIL,
    };
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)(event)) as {
      status: string;
      action_items_written: number;
      mentions_written: number;
      mentions_published: number;
      transcript_id: string;
    };
    expect(result.status).toBe('ok');
    expect(result.action_items_written).toBe(2);
    expect(result.mentions_written).toBe(3);
    expect(result.mentions_published).toBe(3);
    expect(result.transcript_id).toBe(VALID_DETAIL.transcript_id);

    expect(persistState.insertedRuns).toHaveLength(1);
    expect(persistState.insertedRuns[0]!.agentName).toBe('transcript-extractor');
    expect(persistState.transcriptsIndexed).toBe(1);
    // updateAgentRun called once with status='ok' and the output_json carries
    // the action_items_written count.
    const okUpdate = persistState.updatedRuns.find(
      (u) => (u.patch as { status?: string }).status === 'ok',
    );
    expect(okUpdate).toBeDefined();
    expect(
      (okUpdate!.patch.outputJson as { action_items_written?: number }).action_items_written,
    ).toBe(2);
  });

  it('tagTraceWithCaptureId is called with the transcript_id', async () => {
    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'transcript.available',
      detail: VALID_DETAIL,
    };
    await (handler as unknown as (e: unknown) => Promise<unknown>)(event);
    expect(tagSpy).toHaveBeenCalledWith(VALID_DETAIL.transcript_id);
  });

  it('empty transcript body → skipped with reason=empty_transcript', async () => {
    // Override readTranscriptBody just for this test.
    const notionMod = await import('../src/notion.js');
    (notionMod.readTranscriptBody as unknown as { mockImplementationOnce: (f: () => Promise<string>) => void }).mockImplementationOnce(async () => '');

    const { handler } = await import('../src/handler.js');
    const event = {
      source: 'kos.capture',
      'detail-type': 'transcript.available',
      detail: VALID_DETAIL,
    };
    const result = (await (handler as unknown as (e: unknown) => Promise<unknown>)(event)) as {
      status?: string;
      reason?: string;
    };
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('empty_transcript');
    // started run was inserted then closed with status='ok' (not 'error').
    expect(persistState.insertedRuns).toHaveLength(1);
    const lastUpdate = persistState.updatedRuns.at(-1);
    expect((lastUpdate?.patch as { status?: string }).status).toBe('ok');
  });

  it('Zod parse failure on event.detail throws (handled upstream by wrapHandler)', async () => {
    const { handler } = await import('../src/handler.js');
    const badEvent = {
      source: 'kos.capture',
      'detail-type': 'transcript.available',
      detail: { not_a_transcript: true },
    };
    await expect(
      (handler as unknown as (e: unknown) => Promise<unknown>)(badEvent),
    ).rejects.toBeDefined();
  });
});
