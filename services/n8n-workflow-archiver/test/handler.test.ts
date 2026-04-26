/**
 * @kos/service-n8n-workflow-archiver — handler unit tests.
 *
 * Three behaviour cases per Plan 10-00:
 *   1. 0 workflows → empty result, no S3 calls
 *   2. 1 workflow → 1 PutObject + correct sha256
 *   3. 3 workflows → 3 PutObjects + sha256 stable under canonical key
 *      ordering (the same workflow with shuffled keys yields the same
 *      digest)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  handler,
  sha256OfCanonical,
  canonicalJson,
  type N8nWorkflow,
} from '../src/handler.js';

// `aws-sdk-client-mock` v4's generic typing tracks an older SDK constraint
// shape than @aws-sdk/client-s3 3.691.0; runtime behaviour is correct but
// tsc rejects passing the `S3Client` class directly. Cast through `any`
// at the boundary — the Phase-1 services hit the same mismatch and use
// the same workaround.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const s3Mock = mockClient(S3Client as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PutObjectCmd = PutObjectCommand as any;

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCmd).resolves({});
});

describe('n8n-workflow-archiver / handler', () => {
  it('returns empty archive list and makes no S3 calls when input is empty', async () => {
    const result = await handler({
      workflows: [],
      s3Prefix: 'archive/n8n-workflows/',
      bucketName: 'kos-archive-test',
      kmsKeyId: 'arn:aws:kms:eu-north-1:000000000000:key/test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3: s3Mock as any,
    });
    expect(result.archived).toEqual([]);
    expect(s3Mock.commandCalls(PutObjectCmd)).toHaveLength(0);
  });

  it('archives one workflow with the correct SHA-256 and S3 key', async () => {
    const wf: N8nWorkflow = {
      id: 'wf-001',
      name: 'Telegram → Notion ingest',
      nodes: [{ type: 'cron', parameters: {} }],
    };
    const expectedSha = sha256OfCanonical(wf);
    const result = await handler({
      workflows: [wf],
      s3Prefix: '/archive/n8n-workflows', // missing trailing slash on purpose
      bucketName: 'kos-archive-test',
      kmsKeyId: 'arn:aws:kms:eu-north-1:000000000000:key/test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3: s3Mock as any,
    });
    expect(result.archived).toEqual([
      {
        workflow_id: 'wf-001',
        sha256: expectedSha,
        s3_key: 'archive/n8n-workflows/wf-001.json',
      },
    ]);
    const calls = s3Mock.commandCalls(PutObjectCmd);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Bucket).toBe('kos-archive-test');
    expect(input.Key).toBe('archive/n8n-workflows/wf-001.json');
    expect(input.ServerSideEncryption).toBe('aws:kms');
    expect(input.Metadata?.['kos-sha256']).toBe(expectedSha);
  });

  it('SHA-256 is stable across canonical key ordering for 3 workflows', async () => {
    const wfs: N8nWorkflow[] = [
      { id: 'a', name: 'A', nodes: [], settings: { tz: 'UTC' } },
      { id: 'b', name: 'B', nodes: [], settings: { tz: 'UTC' } },
      { id: 'c', name: 'C', nodes: [], settings: { tz: 'UTC' } },
    ];
    const result = await handler({
      workflows: wfs,
      s3Prefix: 'archive/n8n-workflows/',
      bucketName: 'kos-archive-test',
      kmsKeyId: 'arn:aws:kms:eu-north-1:000000000000:key/test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3: s3Mock as any,
    });
    expect(result.archived).toHaveLength(3);
    expect(s3Mock.commandCalls(PutObjectCmd)).toHaveLength(3);

    // Key-ordering stability: shuffle a workflow's keys and confirm the
    // canonical JSON + SHA-256 are identical to the original ordering.
    const original: N8nWorkflow = {
      id: 'wf-stable',
      name: 'name-first',
      nodes: [{ type: 'set', parameters: { foo: 'bar' } }],
    };
    const shuffled: N8nWorkflow = {
      nodes: [{ parameters: { foo: 'bar' }, type: 'set' }],
      name: 'name-first',
      id: 'wf-stable',
    };
    expect(canonicalJson(original)).toBe(canonicalJson(shuffled));
    expect(sha256OfCanonical(original)).toBe(sha256OfCanonical(shuffled));
  });
});
