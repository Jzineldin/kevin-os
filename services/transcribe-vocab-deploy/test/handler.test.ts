import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { handler, stripCommentsAndBlanks } from '../src/handler.js';
import {
  TranscribeClient,
  CreateVocabularyCommand,
  UpdateVocabularyCommand,
  GetVocabularyCommand,
} from '@aws-sdk/client-transcribe';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

function makeBody(text: string): { transformToString: (enc: string) => Promise<string> } {
  // Minimal shim — the real AWS SDK body exposes `transformToString`.
  return { transformToString: async () => text };
}

function setEnv(): void {
  process.env.TRANSCRIBE_REGION = 'eu-north-1';
  process.env.VOCAB_BUCKET = 'kos-blobs-bucket';
  process.env.VOCAB_S3_KEY = 'vocab/sv-se-v1.txt';
  process.env.VOCAB_SEED_BUCKET = 'cdk-asset-bucket';
  process.env.VOCAB_SEED_KEY = 'assets/abc123/sv-se-v1.txt';
}

describe('stripCommentsAndBlanks', () => {
  it('drops comments and blank lines, preserves phrase entries', () => {
    const input = [
      '# header comment',
      '',
      'Kevin',
      'Tale-Forge',
      '   ',
      '# another comment',
      'Almi',
    ].join('\n');
    expect(stripCommentsAndBlanks(input)).toBe('Kevin\nTale-Forge\nAlmi');
  });

  it('handles Windows CRLF line endings', () => {
    const input = '# comment\r\nKevin\r\n\r\nTale-Forge\r\n';
    expect(stripCommentsAndBlanks(input)).toBe('Kevin\nTale-Forge');
  });
});

describe('transcribe-vocab-deploy handler', () => {
  beforeEach(() => {
    setEnv();
  });

  it('on Delete: returns PhysicalResourceId without calling DeleteVocabulary (archive-not-delete)', async () => {
    const transcribeSend = vi.fn();
    const s3Send = vi.fn();
    const transcribe = { send: transcribeSend } as unknown as TranscribeClient;
    const s3 = { send: s3Send } as unknown as S3Client;

    const result = await handler(
      { RequestType: 'Delete' },
      { transcribe, s3, sleep: async () => {}, now: () => 0 },
    );

    expect(result.PhysicalResourceId).toBe('kos-sv-se-v1');
    expect(transcribeSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('on Create: downloads seed, uploads cleaned content, calls CreateVocabulary with sv-SE, polls to READY', async () => {
    const seedContent = ['# comment', 'Kevin', 'Tale-Forge', ''].join('\n');
    const s3Send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        return { Body: makeBody(seedContent) };
      }
      if (cmd instanceof PutObjectCommand) {
        return {};
      }
      throw new Error(`unexpected S3 command: ${cmd}`);
    });

    let getCount = 0;
    const transcribeSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetVocabularyCommand) {
        getCount++;
        if (getCount === 1) {
          // Probe for existing vocab — none yet.
          const err = new Error('not found');
          (err as { name?: string }).name = 'BadRequestException';
          throw err;
        }
        // Second Get = post-create poll.
        return { VocabularyState: 'READY' };
      }
      if (cmd instanceof CreateVocabularyCommand) {
        return {};
      }
      throw new Error(
        `unexpected Transcribe command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
      );
    });

    const transcribe = { send: transcribeSend } as unknown as TranscribeClient;
    const s3 = { send: s3Send } as unknown as S3Client;

    const result = await handler(
      { RequestType: 'Create' },
      { transcribe, s3, sleep: async () => {}, now: () => 0 },
    );

    expect(result.PhysicalResourceId).toBe('kos-sv-se-v1');
    expect(result.Data?.vocabularyState).toBe('READY');

    // Assert CreateVocabulary was called with sv-SE and the canonical S3 URI.
    const createCall = transcribeSend.mock.calls.find(
      ([c]) => c instanceof CreateVocabularyCommand,
    );
    expect(createCall).toBeDefined();
    const createInput = (createCall![0] as CreateVocabularyCommand).input;
    expect(createInput.VocabularyName).toBe('kos-sv-se-v1');
    expect(createInput.LanguageCode).toBe('sv-SE');
    expect(createInput.VocabularyFileUri).toBe('s3://cdk-asset-bucket/vocab-cleaned/sv-se-v1.txt');

    // Assert PutObject uploaded the cleaned (comment-stripped) content.
    const putCall = s3Send.mock.calls.find(([c]) => c instanceof PutObjectCommand);
    expect(putCall).toBeDefined();
    const putInput = (putCall![0] as PutObjectCommand).input;
    expect(putInput.Body).toBe('Kevin\nTale-Forge');
    expect(putInput.Bucket).toBe('cdk-asset-bucket');
    expect(putInput.Key).toBe('vocab-cleaned/sv-se-v1.txt');
  });

  it('on Update: detects existing vocab and calls UpdateVocabulary (not Create)', async () => {
    const s3Send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: makeBody('Kevin\n') };
      if (cmd instanceof PutObjectCommand) return {};
      throw new Error('unexpected');
    });

    let getCount = 0;
    const transcribeSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetVocabularyCommand) {
        getCount++;
        // First call = probe (returns PENDING = vocab exists).
        // Second call = post-update poll.
        return { VocabularyState: 'READY' };
      }
      if (cmd instanceof UpdateVocabularyCommand) return {};
      throw new Error(`unexpected Transcribe command`);
    });

    const transcribe = { send: transcribeSend } as unknown as TranscribeClient;
    const s3 = { send: s3Send } as unknown as S3Client;

    await handler(
      { RequestType: 'Update' },
      { transcribe, s3, sleep: async () => {}, now: () => 0 },
    );

    const updateCall = transcribeSend.mock.calls.find(
      ([c]) => c instanceof UpdateVocabularyCommand,
    );
    const createCall = transcribeSend.mock.calls.find(
      ([c]) => c instanceof CreateVocabularyCommand,
    );
    expect(updateCall, 'should call UpdateVocabulary when vocab exists').toBeDefined();
    expect(createCall, 'should NOT call CreateVocabulary when vocab exists').toBeUndefined();

    const input = (updateCall![0] as UpdateVocabularyCommand).input;
    expect(input.LanguageCode).toBe('sv-SE');
    expect(getCount).toBeGreaterThanOrEqual(2);
  });

  it('throws if vocabulary reaches FAILED state', async () => {
    const s3Send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: makeBody('Kevin\n') };
      if (cmd instanceof PutObjectCommand) return {};
      throw new Error('unexpected');
    });

    let getCount = 0;
    const transcribeSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetVocabularyCommand) {
        getCount++;
        if (getCount === 1) {
          const err = new Error('not found');
          (err as { name?: string }).name = 'BadRequestException';
          throw err;
        }
        return { VocabularyState: 'FAILED', FailureReason: 'bad format' };
      }
      if (cmd instanceof CreateVocabularyCommand) return {};
      throw new Error('unexpected');
    });

    const transcribe = { send: transcribeSend } as unknown as TranscribeClient;
    const s3 = { send: s3Send } as unknown as S3Client;

    await expect(
      handler({ RequestType: 'Create' }, { transcribe, s3, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow(/FAILED.*bad format/);
  });

  it('throws if polling exceeds 5-minute deadline', async () => {
    const s3Send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return { Body: makeBody('Kevin\n') };
      if (cmd instanceof PutObjectCommand) return {};
      throw new Error('unexpected');
    });

    let getCount = 0;
    const transcribeSend = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetVocabularyCommand) {
        getCount++;
        if (getCount === 1) {
          const err = new Error('not found');
          (err as { name?: string }).name = 'BadRequestException';
          throw err;
        }
        return { VocabularyState: 'PENDING' };
      }
      if (cmd instanceof CreateVocabularyCommand) return {};
      throw new Error('unexpected');
    });

    const transcribe = { send: transcribeSend } as unknown as TranscribeClient;
    const s3 = { send: s3Send } as unknown as S3Client;

    // Fake clock: now() jumps forward 60s each call so we hit the 5-min deadline in ~5 iterations.
    let clock = 0;
    const now = () => {
      const v = clock;
      clock += 60_000;
      return v;
    };

    await expect(
      handler({ RequestType: 'Create' }, { transcribe, s3, sleep: async () => {}, now }),
    ).rejects.toThrow(/did not reach READY/);
  });
});
