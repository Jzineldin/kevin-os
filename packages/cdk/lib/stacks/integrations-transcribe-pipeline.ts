/**
 * integrations-transcribe-pipeline — Plan 02-02 (INF-08 voice flow).
 *
 * Wires the two Lambdas + two EventBridge rules that complete CAP-01's voice
 * half:
 *
 *   1. CaptureReceivedVoiceRule — on `kos.capture` bus, source=kos.capture,
 *      detail-type=capture.received, detail.kind=voice → transcribe-starter
 *      Lambda (StartTranscriptionJob).
 *   2. TranscribeJobStateChangeRule — on the default bus,
 *      source=aws.transcribe, detail-type='Transcribe Job State Change',
 *      detail.TranscriptionJobName prefix `kos-` → transcribe-complete Lambda
 *      (read transcript JSON, hydrate sidecar meta, publish
 *      capture.voice.transcribed to kos.capture or transcribe.failed to
 *      kos.system).
 *
 * Per CaptureStack convention (D-04): Lambdas in this stack publish to
 * EventBridge; downstream agent routing happens in Plan 02-04/05 via
 * separate rules. This module owns ONLY the Transcribe pipeline glue.
 *
 * Threat model (Plan 02-02 register):
 *   - T-02-TRANSCRIBE-01 (spoofing): rule filters on `source: aws.transcribe`
 *     (only AWS service can publish) AND `TranscriptionJobName` prefix
 *     `kos-` (prevents cross-tenant TJN confusion).
 *   - T-02-TRANSCRIBE-02 (DoS via duplicate StartTranscriptionJob): job name
 *     is `kos-${capture_id}` (ULID); ConflictException is swallowed in
 *     handler.
 *   - T-02-TRANSCRIBE-03 (tampering on `audio/meta/*`): bucket grant scoped
 *     to read prefix only; downstream zod parsing rejects malformed payloads.
 *
 * Note: the Phase 1 sibling `integrations-transcribe.ts` owns the *vocab*
 * deployment Custom Resource — this file owns the *runtime* pipeline. Names
 * intentionally distinct so the two evolve independently.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface TranscribePipelineProps {
  captureBus: EventBus;
  systemBus: EventBus;
  blobsBucket: IBucket;
  sentryDsnSecret: ISecret;
}

export interface TranscribePipelineWiring {
  starter: KosLambda;
  complete: KosLambda;
  voiceRule: Rule;
  completionRule: Rule;
}

export function wireTranscribePipeline(
  scope: Construct,
  p: TranscribePipelineProps,
): TranscribePipelineWiring {
  // Per-pipeline DLQs live in this stack to avoid a cyclic reference between
  // EventsStack (which owns the capture bus + its DLQ) and CaptureStack: the
  // Rule target DLQ policy would otherwise need to reference a Rule ARN in
  // CaptureStack from a Queue in EventsStack while CaptureStack already
  // depends on EventsStack for the bus ARN.
  const voiceDlq = new Queue(scope, 'TranscribeStarterDlq', {
    queueName: 'kos-transcribe-starter-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });
  const completionDlq = new Queue(scope, 'TranscribeCompleteDlq', {
    queueName: 'kos-transcribe-complete-dlq',
    retentionPeriod: Duration.days(14),
    visibilityTimeout: Duration.minutes(5),
  });

  // --- transcribe-starter Lambda --------------------------------------------
  const starter = new KosLambda(scope, 'TranscribeStarter', {
    entry: svcEntry('transcribe-starter'),
    timeout: Duration.seconds(30),
    memory: 512,
    environment: {
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
      BLOBS_BUCKET: p.blobsBucket.bucketName,
    },
  });
  p.sentryDsnSecret.grantRead(starter);
  p.blobsBucket.grantRead(starter, 'audio/*');
  starter.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['transcribe:StartTranscriptionJob'],
      resources: ['*'], // Transcribe does not support resource-level for StartTranscriptionJob
    }),
  );

  // Rule: kos.capture capture.received kind=voice → starter
  const voiceRule = new Rule(scope, 'CaptureReceivedVoiceRule', {
    eventBus: p.captureBus,
    eventPattern: {
      source: ['kos.capture'],
      detailType: ['capture.received'],
      detail: { kind: ['voice'] },
    },
    targets: [
      new LambdaTarget(starter, {
        deadLetterQueue: voiceDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  // --- transcribe-complete Lambda -------------------------------------------
  const complete = new KosLambda(scope, 'TranscribeComplete', {
    entry: svcEntry('transcribe-complete'),
    timeout: Duration.seconds(30),
    memory: 512,
    environment: {
      SENTRY_DSN_SECRET_ARN: p.sentryDsnSecret.secretArn,
      BLOBS_BUCKET: p.blobsBucket.bucketName,
    },
  });
  p.sentryDsnSecret.grantRead(complete);
  p.blobsBucket.grantRead(complete, 'transcripts/*');
  p.blobsBucket.grantRead(complete, 'audio/meta/*');
  p.captureBus.grantPutEventsTo(complete);
  p.systemBus.grantPutEventsTo(complete);
  complete.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['transcribe:GetTranscriptionJob'],
      resources: ['*'],
    }),
  );

  // Rule: aws.transcribe Transcribe Job State Change kos-* → complete (default bus)
  const completionRule = new Rule(scope, 'TranscribeJobStateChangeRule', {
    eventPattern: {
      source: ['aws.transcribe'],
      detailType: ['Transcribe Job State Change'],
      detail: {
        TranscriptionJobName: [{ prefix: 'kos-' }],
      },
    },
    targets: [
      new LambdaTarget(complete, {
        deadLetterQueue: completionDlq,
        maxEventAge: Duration.hours(1),
        retryAttempts: 2,
      }),
    ],
  });

  return { starter, complete, voiceRule, completionRule };
}
