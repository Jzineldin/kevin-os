/**
 * AgentsStack — Phase 2 Plan 02-04 (AGT-01 triage + AGT-02 voice-capture).
 * Phase 11 Plan 11-01: adds kos-chat Lambda (dedicated chat backend).
 *
 * Thin orchestration shell — all wiring lives in `integrations-agents.ts`
 * so plans can extend the same helper without editing this stack class.
 *
 * Per D-04: Lambdas in this stack only PutEvents to `kos.triage`,
 * `kos.agent`, and `kos.output` and write Notion via the Notion API; they do
 * NOT call other Lambdas synchronously — except kos-chat which exposes a
 * Function URL for the Telegram bot and Vercel proxy to call.
 */
import { Stack, CfnOutput, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  wireTriageAndVoiceCapture,
  wireKosChat,
  type AgentsWiring,
  type KosChatWiring,
} from './integrations-agents.js';

export interface AgentsStackProps extends StackProps {
  captureBus: EventBus;
  triageBus: EventBus;
  agentBus: EventBus;
  outputBus: EventBus;
  notionTokenSecret: ISecret;
  sentryDsnSecret: ISecret;
  langfusePublicSecret: ISecret;
  langfuseSecretSecret: ISecret;
  rdsProxyEndpoint: string;
  rdsIamUser: string;
  rdsProxyDbiResourceId: string;
  kevinOwnerId: string;
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  gmailOauthSecret?: ISecret;
  azureSearchAdminSecret?: ISecret;
  azureSearchIndexName?: string;
  kosChatEndpoint?: string;
  kosDashboardBearerSecret?: ISecret;
  /**
   * Phase 11 Plan 11-01: bearer secret for kos-chat Lambda endpoint auth.
   * Reuses the same kos/dashboard-bearer-token secret (single user, D-09).
   * If absent, kos-chat Lambda is wired without auth (safe in dev, not prod).
   */
  chatBearerSecret?: ISecret;
}

export class AgentsStack extends Stack {
  public readonly agents: AgentsWiring;
  public readonly chat: KosChatWiring;

  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);
    this.agents = wireTriageAndVoiceCapture(this, props);

    // Phase 11 Plan 11-01: kos-chat standalone Lambda.
    if (props.chatBearerSecret) {
      this.chat = wireKosChat(this, {
        rdsProxyEndpoint: props.rdsProxyEndpoint,
        rdsProxyDbiResourceId: props.rdsProxyDbiResourceId,
        notionTokenSecret: props.notionTokenSecret,
        sentryDsnSecret: props.sentryDsnSecret,
        chatBearerSecret: props.chatBearerSecret,
        kevinOwnerId: props.kevinOwnerId,
        vpc: props.vpc,
        rdsSecurityGroup: props.rdsSecurityGroup,
      });

      // Emit the Function URL as a stack output so Vercel + Telegram bot
      // env can be updated after deploy.
      new CfnOutput(this, 'KosChatFunctionUrl', {
        value: this.chat.chatFunctionUrl,
        description: 'kos-chat Lambda Function URL — POST /chat endpoint',
        exportName: 'KosAgents-KosChatFunctionUrl',
      });
    } else {
      // Satisfy TypeScript — in dev synth without chatBearerSecret the chat
      // wiring is a no-op; cast is safe because callers check props.chatBearerSecret.
      this.chat = null as unknown as KosChatWiring;
    }
  }
}
