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

export interface CaptureStackProps extends StackProps {
  blobsBucket: IBucket;
  telegramBotTokenSecret: ISecret;
  telegramWebhookSecret: ISecret;
  sentryDsnSecret: ISecret;
  captureBus: EventBus;
  kevinTelegramUserId: string;
}

export class CaptureStack extends Stack {
  public readonly telegram: TelegramWiring;

  constructor(scope: Construct, id: string, props: CaptureStackProps) {
    super(scope, id, props);
    this.telegram = wireTelegramIngress(this, props);
  }
}
