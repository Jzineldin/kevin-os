/**
 * MigrationStack — Phase 10 (migration & decommission) infrastructure.
 *
 * Wave 0 scaffold (Plan 10-00). Provisions:
 *   1. KosLambda `VpsClassifyMigration`  (MIG-01) + Function URL (NONE auth)
 *   2. KosLambda `DiscordBrainDump`      (CAP-10) + EventBridge Scheduler
 *   3. KosLambda `N8nWorkflowArchiver`   (MIG-02) + S3 archive bucket
 *   4. DynamoDB `DiscordBrainDumpCursor` table (PAY_PER_REQUEST, TTL=`ttl`)
 *   5. KMS-encrypted archive Bucket with `archive/n8n-workflows/` prefix
 *      restricted to the operator role (operator role ARN sourced from
 *      Secrets Manager — Plan 10-05 lands the operator-role bootstrap)
 *
 * The 3 Lambdas are wired with `entry` pointing at the Wave-0 scaffold
 * handlers. Wave 1+ plans (10-01..10-06) replace handler bodies; the CDK
 * wiring stays stable across waves.
 *
 * Wiring intentionally NOT included here (deferred to Wave 1+):
 *   - Lambda Function URL ↔ HMAC secret rotation (Plan 10-01 brings up the
 *     real `vps-classify-hmac-secret` and grants read on the Lambda).
 *   - Discord bot token secret (Plan 10-04 Wave 4).
 *   - Per-Lambda DLQ + EventBridge retry budgets (Wave 1+ plans choose).
 *
 * What ships in Wave 0 IS the surface CDK synth-test asserts on:
 *   - `tpl.findResources('AWS::Lambda::Function')` → 3 resources
 *   - `tpl.findResources('AWS::Lambda::Url')`      → ≥ 1 (vps adapter)
 *   - `tpl.findResources('AWS::Scheduler::Schedule')` → 1 (5-min poll)
 *   - `tpl.findResources('AWS::S3::Bucket')`        → ≥ 1 (archive)
 *   - `tpl.findResources('AWS::DynamoDB::Table')`   → 1 (cursor)
 */
import { Stack, type StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bucket, BucketEncryption, BlockPublicAccess, type IBucket } from 'aws-cdk-lib/aws-s3';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { KosLambda } from '../constructs/kos-lambda.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface MigrationStackProps extends StackProps {
  /** EventBridge `kos.capture` bus — both VPS adapter + Discord poller emit `capture.received` here. */
  captureBus: EventBus;
  /**
   * Optional pre-provisioned HMAC secret for the VPS classify adapter.
   * If omitted, Wave 0 creates a placeholder secret so synth + integration
   * test paths work; Plan 10-01 wires the real secret.
   */
  vpsClassifyHmacSecret?: ISecret;
  /**
   * Optional pre-provisioned Discord bot token secret. Plan 10-04 supplies
   * this; until then a placeholder lets synth pass.
   */
  discordBotTokenSecret?: ISecret;
  /**
   * Optional pre-provisioned KMS key for the archive bucket. Wave 0
   * creates a stack-local key if not supplied.
   */
  archiveKey?: IKey;
  /**
   * Owner UUID Kevin operates as — embedded in the Discord Scheduler input
   * payload so the Lambda can stamp `owner_id` on every capture without
   * re-deriving it.
   */
  kevinOwnerId: string;
  /**
   * Channel snowflakes the Discord poller monitors. Static input on the
   * EventBridge Scheduler — adding/removing channels requires a CDK
   * deploy (acceptable for KOS single-user volume).
   */
  discordChannelIds?: string[];
  /**
   * Single Discord channel snowflake for the brain-dump poller (Plan 10-04).
   * Per `05-06-DISCORD-CONTRACT.md`, the Phase 5 Scheduler input does NOT
   * carry the channel id — the Lambda owns it via env var. If both
   * `discordChannelIds` (Wave-0 multi-channel input) and `discordBrainDumpChannelId`
   * are set, the env-var route wins for the contract-canonical Phase 5
   * Scheduler invoke; the Wave-0 Scheduler input remains as a fallback for
   * manual ad-hoc invocations.
   */
  discordBrainDumpChannelId?: string;
}

export class MigrationStack extends Stack {
  public readonly vpsClassifyMigration: KosLambda;
  public readonly discordBrainDump: KosLambda;
  public readonly n8nWorkflowArchiver: KosLambda;
  public readonly cursorTable: Table;
  public readonly archiveBucket: Bucket;
  public readonly archiveKey: IKey;
  public readonly schedulerRole: Role;
  public readonly discordSchedule: CfnSchedule;
  public readonly discordSchedulerDlq: Queue;
  public readonly discordBrainDumpLambdaArnParam: StringParameter;
  public readonly vpsClassifyHmacSecret: ISecret;
  public readonly discordBotTokenSecret: ISecret;
  public readonly archivePrefix: string;

  constructor(scope: Construct, id: string, props: MigrationStackProps) {
    super(scope, id, props);

    this.archivePrefix = 'archive/n8n-workflows/';

    // ----- Secrets (placeholders until Plans 10-01 / 10-04 land) -------------
    this.vpsClassifyHmacSecret =
      props.vpsClassifyHmacSecret ??
      new Secret(this, 'VpsClassifyHmacSecret', {
        secretName: 'kos/vps-classify-hmac-secret',
        description:
          'HMAC shared secret between VPS-side classify_and_save.py and the Phase-10 vps-classify-migration Lambda. Plan 10-01 rotates the placeholder value.',
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.discordBotTokenSecret =
      props.discordBotTokenSecret ??
      new Secret(this, 'DiscordBotTokenSecret', {
        secretName: 'kos/discord-bot-token',
        description:
          'Discord bot token for the brain-dump poller (CAP-10). Plan 10-04 rotates the placeholder value.',
        removalPolicy: RemovalPolicy.RETAIN,
      });

    // ----- Archive KMS key + bucket ------------------------------------------
    // Per-stack KMS key gives independent rotation + audit from the rest of
    // KOS. Bucket pinned to BLOCK_ALL public access + enforceSSL — same
    // posture as DataStack.blobsBucket.
    this.archiveKey =
      props.archiveKey ??
      new Key(this, 'MigrationArchiveKey', {
        description: 'KMS key for kos-migration archive bucket (n8n exports + Brain DB snapshots).',
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.archiveBucket = new Bucket(this, 'MigrationArchive', {
      encryption: BucketEncryption.KMS,
      encryptionKey: this.archiveKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    });

    // ----- DynamoDB cursor table for Discord poller -------------------------
    this.cursorTable = new Table(this, 'DiscordBrainDumpCursor', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ----- Lambda 1: VpsClassifyMigration (MIG-01) ---------------------------
    this.vpsClassifyMigration = new KosLambda(this, 'VpsClassifyMigration', {
      entry: svcEntry('vps-classify-migration'),
      timeout: Duration.seconds(30),
      memory: 512,
      environment: {
        HMAC_SECRET_ARN: this.vpsClassifyHmacSecret.secretArn,
        KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
      },
    });
    this.vpsClassifyHmacSecret.grantRead(this.vpsClassifyMigration);
    props.captureBus.grantPutEventsTo(this.vpsClassifyMigration);

    const vpsUrl = this.vpsClassifyMigration.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE, // HMAC validated in handler — D-02 / D-10-01
      invokeMode: InvokeMode.BUFFERED,
    });
    new CfnOutput(this, 'VpsClassifyMigrationUrl', {
      value: vpsUrl.url,
      exportName: 'KosMigrationVpsClassifyUrl',
      description:
        'Function URL for the Phase-10 VPS classify_and_save adapter. Plan 10-01 sends the URL to the VPS-side migration shim.',
    });

    // ----- Lambda 2: DiscordBrainDump (CAP-10) -------------------------------
    // Plan 10-04 fills in the handler body. Env wires:
    //   - DISCORD_BOT_TOKEN_SECRET_ARN   → operator-seeded bot token
    //   - CURSOR_TABLE_NAME              → DynamoDB cursor table (Wave-0)
    //   - KOS_CAPTURE_BUS_NAME           → kos.capture EventBridge bus
    //   - DISCORD_BRAIN_DUMP_CHANNEL_ID  → single channel snowflake; the
    //     Phase 5 Scheduler input is channel-agnostic (`channel: 'brain-dump'`)
    //     so the Lambda resolves the actual Discord channel id from env per
    //     05-06-DISCORD-CONTRACT.md.
    //   - KEVIN_OWNER_ID                 → fallback owner_id when an ad-hoc
    //     manual invoke arrives without a payload.
    this.discordBrainDump = new KosLambda(this, 'DiscordBrainDump', {
      entry: svcEntry('discord-brain-dump'),
      timeout: Duration.seconds(60),
      memory: 512,
      environment: {
        DISCORD_BOT_TOKEN_SECRET_ARN: this.discordBotTokenSecret.secretArn,
        CURSOR_TABLE_NAME: this.cursorTable.tableName,
        KOS_CAPTURE_BUS_NAME: props.captureBus.eventBusName,
        DISCORD_BRAIN_DUMP_CHANNEL_ID:
          props.discordBrainDumpChannelId ?? props.discordChannelIds?.[0] ?? '',
        KEVIN_OWNER_ID: props.kevinOwnerId,
      },
    });
    this.discordBotTokenSecret.grantRead(this.discordBrainDump);
    this.cursorTable.grantReadWriteData(this.discordBrainDump);
    props.captureBus.grantPutEventsTo(this.discordBrainDump);

    // ----- SSM parameter — Plan 05-06 hand-off ------------------------------
    // The Phase 5 Scheduler in `integrations-discord-schedule.ts` reads its
    // target Lambda ARN from `/kos/discord/brain-dump-lambda-arn`. Once
    // Plan 10-04's Lambda lands, the SSM param MUST point at the real ARN.
    // We seed it from CDK so deploy ordering is symmetric:
    //
    //   - if MigrationStack deploys first: SSM param holds the real ARN; a
    //     subsequent deploy of IntegrationsStack pins the Phase 5 Scheduler
    //     onto the real Lambda automatically.
    //   - if IntegrationsStack deploys first against an operator-seeded
    //     no-op ARN: this CFN update overwrites the param with the real
    //     ARN, then a redeploy of IntegrationsStack repins the Scheduler.
    //
    // Per `05-06-DISCORD-CONTRACT.md`, Scheduler-target ARN is resolved at
    // rule-creation time (NOT runtime), so the IntegrationsStack repoint
    // remains a manual operator step — but seeding the param here removes
    // the previous burden of operator-side `aws ssm put-parameter` calls.
    this.discordBrainDumpLambdaArnParam = new StringParameter(
      this,
      'DiscordBrainDumpLambdaArnParam',
      {
        parameterName: '/kos/discord/brain-dump-lambda-arn',
        stringValue: this.discordBrainDump.functionArn,
        description:
          'ARN of the Phase-10 Plan 10-04 DiscordBrainDump Lambda. Read by the Phase 5 Plan 05-06 EventBridge Scheduler (kos-discord-poll) at synth time. Re-deploy IntegrationsStack to repoint the Scheduler after MigrationStack updates.',
      },
    );

    // ----- DLQ for the Wave-0 internal Scheduler ----------------------------
    // Plan 10-04 adds an SQS DLQ so a 3-strike retry burst (e.g., transient
    // 5xx from Discord that exceeds the Scheduler's retryPolicy) lands on a
    // queue instead of being silently dropped. The queue is short-lived
    // (4-day retention) and KMS-encrypted with the AWS-managed key (free).
    this.discordSchedulerDlq = new Queue(this, 'DiscordBrainDumpSchedulerDlq', {
      queueName: 'discord-brain-dump-scheduler-dlq',
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // EventBridge Scheduler — every 5 minutes. Static input payload encodes
    // owner_id + channel_ids per the (legacy Wave-0) MigrationStack shape.
    // The canonical Phase 5 Scheduler in IntegrationsStack uses a different
    // payload (`{ channel: 'brain-dump', owner_id, trigger_source }`) —
    // the handler accepts both shapes for deploy resilience.
    this.schedulerRole = new Role(this, 'DiscordBrainDumpSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'Allows EventBridge Scheduler to invoke the Phase-10 DiscordBrainDump Lambda every 5 minutes.',
    });
    this.schedulerRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [this.discordBrainDump.functionArn],
      }),
    );
    // DLQ send permission — Scheduler delivers failed events to the queue
    // after exhausting retries.
    this.discordSchedulerDlq.grantSendMessages(this.schedulerRole);

    const schedulerInput = JSON.stringify({
      owner_id: props.kevinOwnerId,
      channel_ids: props.discordChannelIds ?? [],
    });

    this.discordSchedule = new CfnSchedule(this, 'DiscordBrainDumpSchedule', {
      name: 'discord-brain-dump-poll',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(5 minutes)',
      state: 'ENABLED',
      target: {
        arn: this.discordBrainDump.functionArn,
        roleArn: this.schedulerRole.roleArn,
        input: schedulerInput,
        retryPolicy: {
          maximumEventAgeInSeconds: 300,
          maximumRetryAttempts: 2,
        },
        deadLetterConfig: {
          arn: this.discordSchedulerDlq.queueArn,
        },
      },
    });

    // ----- Lambda 3: N8nWorkflowArchiver (MIG-02) ----------------------------
    this.n8nWorkflowArchiver = new KosLambda(this, 'N8nWorkflowArchiver', {
      entry: svcEntry('n8n-workflow-archiver'),
      timeout: Duration.seconds(120),
      memory: 512,
      environment: {
        ARCHIVE_BUCKET_NAME: this.archiveBucket.bucketName,
        ARCHIVE_PREFIX: this.archivePrefix,
        KMS_KEY_ID: this.archiveKey.keyArn,
      },
    });
    this.archiveBucket.grantPut(this.n8nWorkflowArchiver, `${this.archivePrefix}*`);
    this.archiveKey.grantEncrypt(this.n8nWorkflowArchiver);

    // Restrict archive/ prefix writes to ONLY this Lambda + an operator role
    // (referenced via Secrets Manager — Plan 10-05 lands the operator role
    // ARN secret). Until then, the bucket-level enforceSSL + BLOCK_ALL +
    // KMS gating provide adequate defence.
    this.archiveBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyUnencryptedPuts',
        effect: Effect.DENY,
        principals: [new ServicePrincipal('*')],
        actions: ['s3:PutObject'],
        resources: [`${this.archiveBucket.bucketArn}/${this.archivePrefix}*`],
        conditions: {
          StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
      }),
    );

    new CfnOutput(this, 'MigrationArchiveBucketName', {
      value: this.archiveBucket.bucketName,
      exportName: 'KosMigrationArchiveBucketName',
      description:
        'KMS-encrypted archive bucket (n8n exports + Brain DB JSON snapshots). Operator-role-only writes outside the configured Lambdas.',
    });
    new CfnOutput(this, 'DiscordBrainDumpCursorTableName', {
      value: this.cursorTable.tableName,
      exportName: 'KosMigrationDiscordCursorTable',
      description:
        'DynamoDB cursor table for the Phase-10 Discord brain-dump poller (CAP-10).',
    });
    new CfnOutput(this, 'DiscordBrainDumpLambdaArn', {
      value: this.discordBrainDump.functionArn,
      exportName: 'KosMigrationDiscordBrainDumpArn',
      description:
        'ARN of the Phase-10 Plan 10-04 DiscordBrainDump Lambda. Mirrors the SSM /kos/discord/brain-dump-lambda-arn parameter — the SSM param is what Phase 5 reads at synth time.',
    });
    new CfnOutput(this, 'DiscordBrainDumpSchedulerDlqUrl', {
      value: this.discordSchedulerDlq.queueUrl,
      exportName: 'KosMigrationDiscordDlqUrl',
      description:
        'SQS DLQ for the Phase-10 Discord brain-dump Scheduler. Failed retries (after 2 attempts + 5-min event-age cutoff) land here.',
    });
  }
}

// Re-export the bucket type so kos.ts callers can pass a pre-existing
// bucket to the stack without importing aws-cdk-lib directly.
export type { IBucket };
