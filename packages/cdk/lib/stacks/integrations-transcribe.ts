/**
 * integrations-transcribe — Transcribe sv-SE custom vocabulary wiring for the
 * IntegrationsStack (Plan 01-06).
 *
 * This module exposes a single helper `wireTranscribeVocab()` that plans 04,
 * 05, and 06 (Wave 3) can compose into the shared IntegrationsStack without
 * merge collisions. The helper:
 *
 *   1. Bundles `vocab/sv-se-v1.txt` as a CDK `Asset` (uploaded to the CDK
 *      asset bucket at synth time). Using the Asset construct is mandatory —
 *      shell-copy bundling commands (coreutils copy -r etc.) fail on Windows
 *      dev hosts.
 *   2. Provisions a `KosLambda` running `services/transcribe-vocab-deploy`.
 *      The Lambda is granted read access to the Asset + read/write access to
 *      the KOS blobs bucket, plus `transcribe:{Create,Update,Get}Vocabulary`.
 *   3. Wires a CloudFormation `CustomResource` via the custom-resources
 *      `Provider` pattern. The resource carries `contentHash: vocabAsset.assetHash`
 *      in its properties — when the seed file changes, the Asset hash
 *      changes, CloudFormation diffs the property, and the Lambda receives an
 *      `Update` event which routes to `UpdateVocabulary`.
 *
 * Consuming IntegrationsStack example (to be merged by Plan 04/05 owner):
 *
 *   wireTranscribeVocab(this, {
 *     blobsBucket: props.blobsBucket,
 *     transcribeRegion: props.transcribeRegion,
 *   });
 *
 * Threat model cross-refs:
 *   - T-01-VOCAB-01 (Integrity): Lambda throws on FAILED, CFN surfaces error.
 *   - T-01-VOCAB-02 (Info Disclosure): vocab contains personal names, accepted.
 *   - T-01-VOCAB-03 (Availability): region comes from scripts/.transcribe-region
 *     which the Wave 0 preflight validated against Transcribe sv-SE support.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CustomResource, Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo layout (from packages/cdk/lib/stacks/integrations-transcribe.ts):
//   ../../../../vocab/sv-se-v1.txt
//   ../../../../services/transcribe-vocab-deploy/src/handler.ts
const VOCAB_SEED_PATH = path.join(__dirname, '..', '..', '..', '..', 'vocab', 'sv-se-v1.txt');
const DEPLOY_HANDLER_ENTRY = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'services',
  'transcribe-vocab-deploy',
  'src',
  'handler.ts',
);

export interface WireTranscribeVocabProps {
  /** KOS blobs bucket (from DataStack) where canonical vocab file lives under `vocab/` prefix. */
  blobsBucket: IBucket;
  /** Region for Transcribe API calls (from scripts/.transcribe-region — Wave 0 preflight). */
  transcribeRegion: string;
  /** Canonical S3 key for the vocab file. Defaults to `vocab/sv-se-v1.txt`. */
  s3Key?: string;
}

export interface TranscribeVocabWiring {
  readonly deployFn: KosLambda;
  readonly customResource: CustomResource;
  readonly vocabAsset: Asset;
}

export function wireTranscribeVocab(
  scope: Construct,
  props: WireTranscribeVocabProps,
): TranscribeVocabWiring {
  const s3Key = props.s3Key ?? 'vocab/sv-se-v1.txt';

  // 1. Bundle seed file as a CDK Asset (S3 upload at synth time).
  const vocabAsset = new Asset(scope, 'VocabSeedAsset', {
    path: VOCAB_SEED_PATH,
  });

  // 2. Deploy Lambda.
  const deployFn = new KosLambda(scope, 'TranscribeVocabDeploy', {
    entry: DEPLOY_HANDLER_ENTRY,
    timeout: Duration.minutes(10),
    memory: 512,
    environment: {
      TRANSCRIBE_REGION: props.transcribeRegion,
      VOCAB_BUCKET: props.blobsBucket.bucketName,
      VOCAB_S3_KEY: s3Key,
      VOCAB_SEED_BUCKET: vocabAsset.s3BucketName,
      VOCAB_SEED_KEY: vocabAsset.s3ObjectKey,
    },
  });

  vocabAsset.grantRead(deployFn);
  props.blobsBucket.grantReadWrite(deployFn);
  deployFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'transcribe:CreateVocabulary',
        'transcribe:UpdateVocabulary',
        'transcribe:GetVocabulary',
      ],
      // Transcribe vocabulary ARNs are not scope-restrictable at create time
      // (the resource doesn't exist yet); the Lambda role is already narrowly
      // scoped to this function, so resource:'*' is acceptable.
      resources: ['*'],
    }),
  );

  // 3. CustomResource wired via Provider.
  const vocabProvider = new Provider(scope, 'VocabProvider', {
    onEventHandler: deployFn,
  });
  const customResource = new CustomResource(scope, 'TranscribeVocabulary', {
    serviceToken: vocabProvider.serviceToken,
    properties: {
      // Deterministic over file contents. When vocab/sv-se-v1.txt changes,
      // assetHash changes, CloudFormation diffs the property, and the Lambda
      // fires with RequestType=Update → UpdateVocabulary.
      contentHash: vocabAsset.assetHash,
    },
  });

  return { deployFn, customResource, vocabAsset };
}
