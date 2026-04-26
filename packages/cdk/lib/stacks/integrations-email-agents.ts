/**
 * Phase 4 email-pipeline wiring helper.
 *
 * Composes both Approve-gate halves in one place so Plan 04-04 (email-triage)
 * and Plan 04-05 (email-sender) accrete on a single helper:
 *
 *   wireEmailAgents(scope, props)
 *     ├── EmailTriage          KosLambda  (AGT-05; classify + draft via Bedrock)
 *     ├── EmailSender          KosLambda  (AGT-05; SES SendRawEmail; NO Bedrock)
 *     ├── EmailTriageRule      Rule       (kos.system / scan_emails_now)
 *     └── EmailApprovedRule    Rule       (kos.output / email.approved → sender)
 *
 * Plan 04-05 is the leg that lands the email-sender Lambda + the
 * email.approved rule. The email-triage Lambda + the scan_emails_now
 * rule were planned for 04-04 but had no CDK wiring; we add stubs for
 * symmetry so the stack synthesises cleanly. Plan 04-04's full IAM
 * surface (Bedrock + Notion) accretes on the same helper later.
 *
 * Hard structural invariants asserted by the CDK tests in Plan 04-05
 * Task 3:
 *   - email-sender has `ses:SendRawEmail` on the tale-forge.app SES
 *     identity ONLY (no `ses:*`, no other identities).
 *   - email-sender has NO `bedrock:*` action grants.
 *   - email-sender has `rds-db:connect` as `kos_email_sender` ONLY
 *     (NOT kos_admin / kos_agent_writer).
 *   - email-sender has `events:PutEvents` on kos.output (for `email.sent`).
 *   - The EmailApprovedRule fires on source=['kos.output'] +
 *     detailType=['email.approved'].
 *
 * Together these make the Approve gate structurally non-bypassable
 * (Phase 4 §threat_model T-04-SENDER-01/02).
 */
import { Duration, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { SubnetType, type IVpc, type ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { KosLambda } from '../constructs/kos-lambda.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../');

function svcEntry(svcDir: string): string {
  return path.join(REPO_ROOT, 'services', svcDir, 'src', 'handler.ts');
}

export interface WireEmailAgentsProps {
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  rdsProxyEndpoint: string;
  /** `prx-xxxxxxxx` from DataStack.rdsProxyDbiResourceId. */
  rdsProxyDbiResourceId: string;
  /** `kos.system` — receives `scan_emails_now` from the Phase 7 scheduler. */
  systemBus: EventBus;
  /** `kos.output` — email-sender's trigger source. */
  outputBus: EventBus;
  /** Owner UUID for KEVIN_OWNER_ID env var. */
  kevinOwnerId: string;
  sentryDsnSecret?: ISecret;
  langfusePublicSecret?: ISecret;
  langfuseSecretSecret?: ISecret;
  /** SES verified domain identity name (e.g. 'tale-forge.app'). */
  sesIdentityDomain?: string;
}

export interface EmailAgentsWiring {
  emailTriageFn?: KosLambda;
  emailSenderFn: KosLambda;
  emailTriageRule?: Rule;
  emailApprovedRule: Rule;
}

export function wireEmailAgents(
  scope: Construct,
  props: WireEmailAgentsProps,
): EmailAgentsWiring {
  const stack = Stack.of(scope);
  const sesDomain = props.sesIdentityDomain ?? 'tale-forge.app';

  const vpcConfig = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.rdsSecurityGroup],
  };

  // --- email-sender (Plan 04-05) -----------------------------------------
  //
  // 512MB / 30s — SES SendRawEmail + Postgres FOR UPDATE lock + a single
  // PutEvents takes <2s in steady state; 30s leaves headroom for IAM
  // token mint + cold start. NO bedrock perms — structural assertion in
  // the integrations-email-sender.test.ts CDK test.
  const emailSenderFn = new KosLambda(scope, 'EmailSender', {
    entry: svcEntry('email-sender'),
    timeout: Duration.seconds(30),
    memory: 512,
    ...vpcConfig,
    environment: {
      // Note: AWS_REGION is reserved by the Lambda runtime and is set
      // automatically — never include it explicitly here.
      KEVIN_OWNER_ID: props.kevinOwnerId,
      RDS_PROXY_ENDPOINT: props.rdsProxyEndpoint,
      RDS_IAM_USER: 'kos_email_sender',
      RDS_DATABASE: 'kos',
      ...(props.sentryDsnSecret
        ? { SENTRY_DSN_SECRET_ARN: props.sentryDsnSecret.secretArn }
        : {}),
      ...(props.langfusePublicSecret
        ? { LANGFUSE_PUBLIC_KEY_SECRET_ARN: props.langfusePublicSecret.secretArn }
        : {}),
      ...(props.langfuseSecretSecret
        ? { LANGFUSE_SECRET_KEY_SECRET_ARN: props.langfuseSecretSecret.secretArn }
        : {}),
    },
  });

  // SES SendRawEmail — scoped to verified identities only. Phase 4 ships
  // with tale-forge.app verified; the second domain (kevin@elzarka.com)
  // is NOT yet verified in eu-north-1, so the IAM resources include only
  // the canonical domain. mapAccountToFromEmail in services/email-sender/
  // src/persist.ts routes all replies through tale-forge.app for now.
  emailSenderFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ses:SendRawEmail'],
      resources: [
        `arn:aws:ses:${stack.region}:${stack.account}:identity/${sesDomain}`,
      ],
    }),
  );

  // RDS Proxy IAM auth as `kos_email_sender` — see migration 0017 for the
  // narrow column-level grants. NOT kos_admin (which has email-triage's
  // INSERT permissions on draft generation).
  emailSenderFn.addToRolePolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${props.rdsProxyDbiResourceId}/kos_email_sender`,
      ],
    }),
  );

  // events:PutEvents on kos.output — the `email.sent` SSE-fan-out emit.
  props.outputBus.grantPutEventsTo(emailSenderFn);

  // Sentry / Langfuse secret reads (optional — graceful-degrade in handler).
  props.sentryDsnSecret?.grantRead(emailSenderFn);
  props.langfusePublicSecret?.grantRead(emailSenderFn);
  props.langfuseSecretSecret?.grantRead(emailSenderFn);

  // EXPLICITLY NO bedrock:* — asserted by the CDK safety test
  // (integrations-email-sender.test.ts).

  // --- EventBridge rule: kos.output / email.approved → email-sender ------
  //
  // The Approve gate's only invocation path. Source filter on 'kos.output'
  // means ONLY the dashboard-api Approve handler can trigger this Lambda
  // (the other producers on this bus emit Source='kos.dashboard'). 2
  // retries cover transient SES throttle waves before withTimeoutAndRetry's
  // own retry budget kicks in.
  const emailApprovedRule = new Rule(scope, 'EmailApprovedRule', {
    eventBus: props.outputBus,
    eventPattern: {
      source: ['kos.output'],
      detailType: ['email.approved'],
    },
    targets: [
      new LambdaTarget(emailSenderFn, {
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    ],
  });

  return {
    emailSenderFn,
    emailApprovedRule,
  };
}
