/**
 * Replay-cache tests (CAP-02 / D-15).
 *
 * Mocks the @aws-sdk/client-dynamodb module so the test runs without a
 * real DynamoDB endpoint. The mock exposes a shared `mockSend` we can
 * assert PutItem args against, plus the real `ConditionalCheckFailedException`
 * shape so the handler's `instanceof` check works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

class ConditionalCheckFailedException extends Error {
  $fault = 'client' as const;
  $metadata = {};
  constructor(message = 'conditional check failed') {
    super(message);
    this.name = 'ConditionalCheckFailedException';
  }
}

vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    PutItemCommand: vi.fn().mockImplementation((x: unknown) => ({ input: x })),
    ConditionalCheckFailedException,
  };
});

describe('recordSignature', () => {
  const SIG = 'a'.repeat(64);
  const NOW = 1714028400;

  beforeEach(async () => {
    process.env.AWS_REGION = 'eu-north-1';
    process.env.REPLAY_TABLE_NAME = 'kos-ios-webhook-replay';
    mockSend.mockReset();
    vi.resetModules();
    const mod = await import('../src/replay.js');
    mod.__resetReplayForTests();
  });

  it('first record for a signature → duplicate:false; PutItem with ConditionExpression + TTL=now+600', async () => {
    mockSend.mockResolvedValueOnce({});
    const { recordSignature } = await import('../src/replay.js');
    const r = await recordSignature(SIG, NOW);
    expect(r).toEqual({ duplicate: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0] as {
      input: {
        TableName: string;
        Item: {
          signature: { S: string };
          received_at: { N: string };
          expires_at: { N: string };
        };
        ConditionExpression: string;
      };
    };
    expect(cmd.input.TableName).toBe('kos-ios-webhook-replay');
    expect(cmd.input.Item.signature.S).toBe(SIG);
    expect(cmd.input.Item.received_at.N).toBe(String(NOW));
    expect(cmd.input.Item.expires_at.N).toBe(String(NOW + 600));
    expect(cmd.input.ConditionExpression).toBe(
      'attribute_not_exists(signature)',
    );
  });

  it('duplicate signature (ConditionalCheckFailedException) → duplicate:true; no throw', async () => {
    mockSend.mockRejectedValueOnce(new ConditionalCheckFailedException());
    const { recordSignature } = await import('../src/replay.js');
    const r = await recordSignature(SIG, NOW);
    expect(r).toEqual({ duplicate: true });
  });

  it('other DDB errors are rethrown', async () => {
    const boom = new Error('ProvisionedThroughputExceededException');
    boom.name = 'ProvisionedThroughputExceededException';
    mockSend.mockRejectedValueOnce(boom);
    const { recordSignature } = await import('../src/replay.js');
    await expect(recordSignature(SIG, NOW)).rejects.toThrow(
      /ProvisionedThroughputExceededException/,
    );
  });

  it('expires_at is exactly nowSec+600 (2× the ±300s HMAC drift window)', async () => {
    mockSend.mockResolvedValue({});
    const { recordSignature } = await import('../src/replay.js');
    const cases = [
      { now: 1_700_000_000, expected: '1700000600' },
      { now: 1_714_028_400, expected: '1714029000' },
      { now: 0, expected: '600' },
    ];
    for (const { now, expected } of cases) {
      mockSend.mockClear();
      await recordSignature(SIG, now);
      const cmd = mockSend.mock.calls[0]![0] as {
        input: { Item: { expires_at: { N: string } } };
      };
      expect(cmd.input.Item.expires_at.N).toBe(expected);
    }
  });
});
