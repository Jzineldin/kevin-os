/**
 * Notion indexer + backfill + reconcile wiring helper for IntegrationsStack.
 *
 * Lives in its own file so Plans 05 (Azure Search bootstrap) and 06 (Transcribe
 * vocab) can add their own helpers to IntegrationsStack without merge conflict.
 *
 * Exports:
 *  - wireNotionIntegrations(scope, props) — installs:
 *      * notion-indexer Lambda (outside VPC; IAM auth to RDS Proxy)
 *      * notion-indexer-backfill Lambda
 *      * notion-reconcile Lambda
 *      * EventBridge Scheduler entries (4 indexer schedules + weekly reconcile)
 *      * IAM `rds-db:connect` grants on the Proxy DbiResourceId
 */

import { Stack, Duration } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNotionIds, type NotionIds } from './_notion-ids.js';

// Resolve __dirname in ESM for node:path usage.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type { NotionIds };

export interface WireNotionProps {
  vpc: IVpc;
  /**
   * RDS Proxy security group — required so notion-indexer (and the backfill
   * + reconcile Lambdas) can open a TCP socket to RDS Proxy from inside the
   * VPC. Without this every `pg.Pool` connect times out (live-discovered
   * 2026-04-22 — Phase 1 deploy ran for ~3 days with notion-indexer
   * silently failing every 5-min schedule, no `last_error` surfaced).
   */
  rdsSecurityGroup: ISecurityGroup;
  rdsSecret: ISecret;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` identifier from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  notionTokenSecret: ISecret;
  captureBus: EventBus;
  systemBus: EventBus;
  scheduleGroupName: string;
}

export interface NotionWiring {
  notionIndexer: KosLambda;
  notionIndexerBackfill: KosLambda;
  notionReconcile: KosLambda;
  schedulerRole: Role;
}

const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export function wireNotionIntegrations(scope: Construct, props: WireNotionProps): NotionWiring {
  const NOTION_IDS = loadNotionIds();
  const stack = Stack.of(scope);
  const rdsDbConnectResource = `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/kos_admin`;

  // Spread into every KosLambda so the notion-indexer trio land in the
  // private isolated subnets and can reach RDS Proxy. Live-discovered
  // 2026-04-22 — Phase 1's notion-indexer was failing every 5-min poll.
  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // --- notion-indexer Lambda (5-min poller) ---------------------------------
  // Plan 02-07: NOTION_KOS_INBOX_DB_ID + NOTION_ENTITIES_DB_ID injected so the
  // 'kos_inbox' branch can (a) query the Inbox DB on its own schedule and
  // (b) create new Entities-DB pages on Status=Approved transitions.
  const notionIndexer = new KosLambda(scope, 'NotionIndexer', {
    entry: svcEntry('notion-indexer'),
    timeout: Duration.minutes(2),
    memory: 512,
    ...vpcConfig,
    environment: {
      NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
      RDS_ENDPOINT: props.rdsProxyEndpoint,
      RDS_USER: 'kos_admin',
      RDS_DATABASE: 'kos',
      CAPTURE_BUS_NAME: props.captureBus.eventBusName,
      NOTION_KOS_INBOX_DB_ID: NOTION_IDS.kosInbox,
      NOTION_ENTITIES_DB_ID: NOTION_IDS.entities,
    },
  });
  props.notionTokenSecret.grantRead(notionIndexer);
  props.captureBus.grantPutEventsTo(notionIndexer);
  notionIndexer.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );
  // 2026-04-22 (Wave 5 Gap A): Plan 02-08 extended notion-indexer to embed
  // entity rows via Cohere Embed v4. Grant Bedrock InvokeModel on the EU
  // inference profile + the foundation-model ARNs it fans out to.
  notionIndexer.addToRolePolicy(
    new PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/eu.cohere.embed-v4*',
        'arn:aws:bedrock:*::foundation-model/cohere.embed-v4*',
      ],
    }),
  );

  // --- notion-indexer-backfill Lambda (one-shot full scan) ------------------
  const notionIndexerBackfill = new KosLambda(scope, 'NotionIndexerBackfill', {
    entry: svcEntry('notion-indexer-backfill'),
    timeout: Duration.minutes(15),
    memory: 1024,
    ...vpcConfig,
    environment: {
      NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
      RDS_SECRET_ARN: props.rdsSecret.secretArn,
      RDS_ENDPOINT: props.rdsProxyEndpoint,
      RDS_USER: 'kos_admin',
      RDS_DATABASE: 'kos',
    },
  });
  props.notionTokenSecret.grantRead(notionIndexerBackfill);
  props.rdsSecret.grantRead(notionIndexerBackfill);
  notionIndexerBackfill.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  // --- notion-reconcile Lambda (weekly full-scan hard-delete detector) ------
  const notionReconcile = new KosLambda(scope, 'NotionReconcile', {
    entry: svcEntry('notion-reconcile'),
    timeout: Duration.minutes(15),
    memory: 1024,
    ...vpcConfig,
    environment: {
      NOTION_TOKEN_SECRET_ARN: props.notionTokenSecret.secretArn,
      RDS_ENDPOINT: props.rdsProxyEndpoint,
      RDS_USER: 'kos_admin',
      RDS_DATABASE: 'kos',
      SYSTEM_BUS_NAME: props.systemBus.eventBusName,
      NOTION_ENTITIES_DB_ID: NOTION_IDS.entities,
      NOTION_PROJECTS_DB_ID: NOTION_IDS.projects,
      NOTION_KEVIN_CONTEXT_PAGE_ID: NOTION_IDS.kevinContext,
      NOTION_COMMAND_CENTER_DB_ID: NOTION_IDS.commandCenter,
    },
  });
  props.notionTokenSecret.grantRead(notionReconcile);
  props.systemBus.grantPutEventsTo(notionReconcile);
  notionReconcile.addToRolePolicy(
    new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [rdsDbConnectResource],
    }),
  );

  // --- Scheduler role --------------------------------------------------------
  // Trust policy: scheduler.amazonaws.com. We intentionally DO NOT add an
  // aws:SourceArn condition because AWS Scheduler validates the role at
  // schedule-creation time by calling sts:AssumeRole BEFORE the schedule ARN
  // exists — reproduced 2026-04-22 with error "The execution role you provide
  // must allow AWS EventBridge Scheduler to assume the role". Blast radius is
  // still narrow: grantInvoke calls below restrict which Lambdas this role
  // can invoke (notionIndexer + notionReconcile only).
  const schedulerRole = new Role(scope, 'SchedulerRole', {
    assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
  });
  void stack; // preserved for future use; condition previously referenced it
  notionIndexer.grantInvoke(schedulerRole);
  notionReconcile.grantInvoke(schedulerRole);

  // --- Indexer schedules (4 per D-11 + 1 per Plan 02-07 KOS Inbox) ---------
  // Plan 02-07 adds the 5th schedule (`kos-inbox-poll`) — the same indexer
  // Lambda runs against KOS Inbox every 5 min with dbKind='kos_inbox'. The
  // handler dispatches to processKosInboxBatch which syncs Status transitions
  // (Approved → create/reuse Entities page + flip to Merged; Rejected → archive).
  const watched = [
    { key: 'Entities', dbId: NOTION_IDS.entities, dbKind: 'entities' },
    { key: 'Projects', dbId: NOTION_IDS.projects, dbKind: 'projects' },
    { key: 'KevinContext', dbId: NOTION_IDS.kevinContext, dbKind: 'kevin_context' },
    { key: 'CommandCenter', dbId: NOTION_IDS.commandCenter, dbKind: 'command_center' },
    { key: 'KosInbox', dbId: NOTION_IDS.kosInbox, dbKind: 'kos_inbox' },
  ] as const;

  for (const w of watched) {
    // Plan 02-07: KOS Inbox schedule is named 'kos-inbox-poll' to match the
    // operator-friendly naming the plan acceptance test greps for.
    const scheduleName =
      w.key === 'KosInbox' ? 'kos-inbox-poll' : 'notion-indexer-' + w.key.toLowerCase();
    new CfnSchedule(scope, 'IndexerSchedule-' + w.key, {
      name: scheduleName,
      groupName: props.scheduleGroupName,
      scheduleExpression: 'rate(5 minutes)',
      scheduleExpressionTimezone: 'Europe/Stockholm',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: notionIndexer.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ dbId: w.dbId, dbKind: w.dbKind, dbName: w.key === 'KosInbox' ? 'kosInbox' : undefined }),
      },
      state: 'ENABLED',
    });
  }

  // --- Weekly reconcile schedule (Sun 04:00 Europe/Stockholm) ---------------
  new CfnSchedule(scope, 'ReconcileSchedule', {
    name: 'notion-reconcile-weekly',
    groupName: props.scheduleGroupName,
    scheduleExpression: 'cron(0 4 ? * SUN *)',
    scheduleExpressionTimezone: 'Europe/Stockholm',
    flexibleTimeWindow: { mode: 'OFF' },
    target: {
      arn: notionReconcile.functionArn,
      roleArn: schedulerRole.roleArn,
      input: '{}',
    },
    state: 'ENABLED',
  });

  return { notionIndexer, notionIndexerBackfill, notionReconcile, schedulerRole };
}
