/**
 * CaptureStack — Phase 2 ingress layer for Telegram + (future) other channels.
 *
 * Plan 02-01 (CAP-01) lands the Telegram bot. Future plans add email/iOS-
 * shortcut/Chrome-extension ingress helpers as siblings to
 * `integrations-telegram.ts` so plans don't merge-conflict.
 *
 * Hard rule (D-04): Lambdas in this stack MUST NOT invoke agents directly.
 * They only PutEvents to `kos.capture`; downstream routing happens via
 * EventBridge rules attached by the triage / voice-capture / entity-resolver
 * plans.
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import {
  wireTelegramIngress,
  type TelegramWiring,
} from './integrations-telegram.js';
import {
  wireTranscribePipeline,
  type TranscribePipelineWiring,
} from './integrations-transcribe-pipeline.js';

export interface CaptureStackProps extends StackProps {
  blobsBucket: IBucket;
  telegramBotTokenSecret: ISecret;
  telegramWebhookSecret: ISecret;
  sentryDsnSecret: ISecret;
  captureBus: EventBus;
  systemBus: EventBus;
  kevinTelegramUserId: string;
  /** Phase 11 Plan 11-03: Vercel /api/chat URL for /ask + /chat commands. */
  kosChatEndpoint: string;
  /** Dashboard bearer secret — injected at deploy into telegram-bot env. */
  kosDashboardBearerSecret: ISecret;
}

export class CaptureStack extends Stack {
  public readonly telegram: TelegramWiring;
  public readonly transcribe: TranscribePipelineWiring;

  constructor(scope: Construct, id: string, props: CaptureStackProps) {
    super(scope, id, props);
    this.telegram = wireTelegramIngress(this, props);
    this.transcribe = wireTranscribePipeline(this, {
      captureBus: props.captureBus,
      systemBus: props.systemBus,
      blobsBucket: props.blobsBucket,
      sentryDsnSecret: props.sentryDsnSecret,
    });
  }
}
