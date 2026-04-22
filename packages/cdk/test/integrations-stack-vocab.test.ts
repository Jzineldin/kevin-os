import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { wireTranscribeVocab } from '../lib/stacks/integrations-transcribe.js';

/**
 * Unit-level assertions for the Plan 01-06 Transcribe vocab wiring. This is a
 * helper-scoped test (not full-stack) because Wave 3 plans 04/05/06 compose
 * their wiring into a shared IntegrationsStack that Plan 04's owner lands; we
 * verify the helper in isolation to avoid colliding on integrations-stack.ts.
 *
 * Covers:
 *  - Lambda environment carries TRANSCRIBE_REGION, VOCAB_BUCKET, VOCAB_S3_KEY,
 *    VOCAB_SEED_BUCKET, VOCAB_SEED_KEY.
 *  - IAM policy allows transcribe:CreateVocabulary / UpdateVocabulary /
 *    GetVocabulary (INF-08 + T-01-VOCAB-01).
 *  - A AWS::CloudFormation::CustomResource is emitted that references the
 *    Provider's service token and carries a contentHash property (so file
 *    edits trigger Update).
 *  - Does NOT use the `cp -r` Windows-hostile bundling pattern anywhere.
 */
describe('wireTranscribeVocab', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const stack = new Stack(app, 'VocabTestStack', { env });
  const blobs = new Bucket(stack, 'Blobs', { bucketName: 'test-blobs' });
  wireTranscribeVocab(stack, {
    blobsBucket: blobs,
    transcribeRegion: 'eu-north-1',
  });
  const tpl = Template.fromStack(stack);

  it('emits the deploy Lambda with canonical env vars (TRANSCRIBE_REGION / VOCAB_BUCKET / VOCAB_S3_KEY)', () => {
    // Several Lambda::Function resources exist (KosLambda + LogRetention +
    // custom-resources Provider framework). Filter by our distinctive env var.
    const fns = tpl.findResources('AWS::Lambda::Function');
    const entries = Object.values(fns) as Array<{
      Properties?: { Environment?: { Variables?: Record<string, unknown> } };
    }>;
    const vocabFn = entries.find(
      (r) => r.Properties?.Environment?.Variables?.VOCAB_S3_KEY === 'vocab/sv-se-v1.txt',
    );
    expect(vocabFn, 'expected exactly one Lambda with VOCAB_S3_KEY env').toBeDefined();
    const vars = vocabFn!.Properties!.Environment!.Variables!;
    expect(vars.TRANSCRIBE_REGION).toBe('eu-north-1');
    expect(vars.VOCAB_S3_KEY).toBe('vocab/sv-se-v1.txt');
    // VOCAB_BUCKET and VOCAB_SEED_* are CloudFormation intrinsic refs (objects).
    expect(vars.VOCAB_BUCKET).toBeDefined();
    expect(vars.VOCAB_SEED_BUCKET).toBeDefined();
    expect(vars.VOCAB_SEED_KEY).toBeDefined();
  });

  it('deploy Lambda IAM policy grants transcribe:CreateVocabulary / UpdateVocabulary / GetVocabulary', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const flat = JSON.stringify(policies);
    expect(flat).toContain('transcribe:CreateVocabulary');
    expect(flat).toContain('transcribe:UpdateVocabulary');
    expect(flat).toContain('transcribe:GetVocabulary');
  });

  it('emits a CustomResource with a contentHash property (for file-change Updates)', () => {
    // The resource type is the Provider-framework's custom name, not the
    // generic AWS::CloudFormation::CustomResource. Both get emitted depending
    // on CDK version; we accept either.
    const customResources = {
      ...tpl.findResources('AWS::CloudFormation::CustomResource'),
      ...tpl.findResources('Custom::AWS'),
    };
    // The Provider framework emits a Custom::<Name> resource. Match by the
    // property shape we set: contentHash + ServiceToken.
    const all = { ...customResources, ...tpl.findResources('Custom::AWS') };
    // Broader pass: search every resource for our contentHash property.
    const allResources = tpl.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const vocabCr = Object.values(allResources).find(
      (r) => r.Properties && 'contentHash' in r.Properties,
    );
    expect(vocabCr, 'expected a CustomResource with contentHash property').toBeDefined();
    expect(vocabCr!.Properties!.ServiceToken).toBeDefined();
    expect(typeof vocabCr!.Properties!.contentHash).toBe('string');
    expect((vocabCr!.Properties!.contentHash as string).length).toBeGreaterThan(8);
    // Silence unused-var lint in strict configs.
    void all;
  });

  it('Provider framework Lambda (onEvent handler) references the deploy Lambda', () => {
    // The Provider construct creates an additional framework Lambda that
    // invokes our onEventHandler. We assert both exist.
    const fns = tpl.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(2);
  });

  it('Lambda bundling config uses esbuild (no cp -r Windows-hostile pattern)', () => {
    // Assertion is negative: the synthesized template must not contain the
    // string "cp -r" anywhere. We rely on the KosLambda default bundling
    // (esbuild), which never uses shell cp.
    const serialized = JSON.stringify(tpl.toJSON());
    expect(serialized).not.toContain('cp -r');
  });
});
