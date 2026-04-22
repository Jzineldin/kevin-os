/**
 * SafetyStack — Phase 1 safety rails (D-12, D-13, D-15):
 *
 *   1. DynamoDB `TelegramCap` table — single-key, TTL-swept, on-demand.
 *      Partition key = `telegram-cap#YYYY-MM-DD` (Stockholm date).
 *   2. push-telegram Lambda (outside VPC per D-05; Telegram API is public).
 *      Uses @kos/service-push-telegram handler which enforces cap + quiet
 *      hours INLINE (research Anti-Pattern line 607).
 *   3. SNS `CostAlarmTopic` with email subscription to ALARM_EMAIL (Pitfall 1:
 *      subscription stays PendingConfirmation until Kevin clicks the link).
 *   4. AWS Budgets `kos-monthly` — $50 actual warn, $100 actual critical,
 *      $100 forecasted — each notification publishes into the SNS topic.
 *      (Not CloudWatch billing alarms — research explicitly advises AWS
 *      Budgets; see RESEARCH Don't-Hand-Roll "Cost alarm routing".)
 *
 * Threat mitigations wired here:
 *   T-01-06: cap enforcement lives in the sender Lambda (cannot be bypassed
 *            by routing to a different EventBridge target).
 *   T-01-BUDGET-01: documented manual-confirmation step (SUMMARY runbook).
 *   T-01-SNS-01: resource policy scopes `budgets.amazonaws.com` Publish to
 *                the specific `kos-monthly` budget via aws:SourceArn.
 */
import { Stack, type StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
// Note: AWS::Budgets::Budget CFN resource is only supported in us-east-1.
// We create the budget out-of-band via `aws budgets create-budget` (post-deploy)
// targeting this stack's alarmTopic ARN. See scripts/create-cost-budget.sh.
// import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KosLambda } from '../constructs/kos-lambda.js';
import { ALARM_EMAIL } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SafetyStackProps extends StackProps {
  rdsSecret: ISecret;
  rdsProxyEndpoint: string;
  telegramBotTokenSecret: ISecret;
}

export class SafetyStack extends Stack {
  public readonly capTable: Table;
  public readonly pushTelegram: KosLambda;
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: SafetyStackProps) {
    super(scope, id, props);

    // --- DynamoDB cap table -------------------------------------------------
    // D-12: on-demand billing; TTL attribute = `ttl` (epoch seconds, 48h
    // ahead); single partition key `pk`. RETAIN so `cdk destroy` never
    // wipes historical cap state.
    this.capTable = new Table(this, 'TelegramCap', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- push-telegram Lambda (OUTSIDE VPC per D-05) ------------------------
    // Telegram API is public; RDS Proxy (for queue writes on denial) accepts
    // TLS/IAM-auth from the public internet (see DataStack). Keeping this
    // Lambda outside the VPC avoids a NAT Gateway which would be the #1
    // cost driver we're trying to avoid (STATE.md / RESEARCH).
    const handlerEntry = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'services',
      'push-telegram',
      'src',
      'handler.ts',
    );
    this.pushTelegram = new KosLambda(this, 'PushTelegram', {
      entry: handlerEntry,
      timeout: Duration.seconds(30),
      memory: 512,
      environment: {
        CAP_TABLE_NAME: this.capTable.tableName,
        RDS_SECRET_ARN: props.rdsSecret.secretArn,
        RDS_ENDPOINT: props.rdsProxyEndpoint,
        TELEGRAM_BOT_TOKEN_SECRET_ARN: props.telegramBotTokenSecret.secretArn,
      },
    });
    this.capTable.grantReadWriteData(this.pushTelegram);
    props.rdsSecret.grantRead(this.pushTelegram);
    props.telegramBotTokenSecret.grantRead(this.pushTelegram);

    // --- SNS topic + email subscription -------------------------------------
    // D-15: cost alarms route ONLY to email, never Telegram (Telegram is
    // cap-gated and quiet-hours-suppressed). Subscription is PendingConfirmation
    // until Kevin clicks the AWS confirmation link (T-01-BUDGET-01 runbook).
    this.alarmTopic = new Topic(this, 'CostAlarmTopic', {
      displayName: 'KOS cost alarms',
    });
    this.alarmTopic.addSubscription(new EmailSubscription(ALARM_EMAIL));

    // --- AWS Budgets (D-15) -------------------------------------------------
    // NOTE: AWS::Budgets::Budget is NOT supported as a CloudFormation resource
    // type in eu-north-1 (CFN validation returns "Unrecognized resource types"
    // — reproduced 2026-04-22). Budgets is a global API service but the CFN
    // resource type is only registered in us-east-1.
    //
    // Workaround: the budget is created out-of-band via `aws budgets
    // create-budget` (see scripts/create-cost-budget.sh), targeting this
    // stack's alarmTopic ARN. The SNS topic + resource policy below stay here
    // because they ARE regional and they're what Budgets will Publish to.

    // T-01-SNS-01 mitigation: scope the Budgets service principal's Publish
    // permission to the specific `kos-monthly` budget via aws:SourceArn, so a
    // compromised or rogue Budgets configuration elsewhere in the account
    // cannot spam Kevin's email via this topic.
    this.alarmTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowBudgetsPublish',
        actions: ['sns:Publish'],
        principals: [new ServicePrincipal('budgets.amazonaws.com')],
        resources: [this.alarmTopic.topicArn],
        conditions: {
          ArnLike: {
            'aws:SourceArn': `arn:aws:budgets::${Stack.of(this).account}:budget/kos-monthly`,
          },
        },
      }),
    );
  }
}
