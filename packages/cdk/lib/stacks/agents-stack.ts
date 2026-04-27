/**
 * AgentsStack — Phase 2 Plan 02-04 (AGT-01 triage + AGT-02 voice-capture).
 *
 * Thin orchestration shell — all wiring lives in `integrations-agents.ts`
 * so Plan 02-05 (entity-resolver) can extend the same helper without
 * editing this stack class.
 *
 * Per D-04: Lambdas in this stack only PutEvents to `kos.triage`,
 * `kos.agent`, and `kos.output` and write Notion via the Notion API; they do
 * NOT call other Lambdas synchronously.
 */
import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { EventBus } from 'aws-cdk-lib/aws-events';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  wireTriageAndVoiceCapture,
  type AgentsWiring,
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
  /**
   * VPC + SG that allow agent Lambdas to reach RDS Proxy. Without these the
   * Lambdas land in the public Lambda network and time out on `pg.Pool`
   * (live-discovered 2026-04-22 during Wave 5 E2E — both notion-indexer and
   * every Phase 2 agent had `VpcConfig: null`).
   */
  vpc: IVpc;
  rdsSecurityGroup: ISecurityGroup;
  /** Plan 02-09 (ENT-06): Gmail OAuth tokens secret. Optional. */
  gmailOauthSecret?: ISecret;
  /**
   * Phase 6 AGT-04 gap closure (Plan 06-07): each agent Lambda calls
   * loadContext({ azureSearch: hybridQuery }) which reads
   * AZURE_SEARCH_ADMIN_SECRET_ARN at cold start. Optional so existing test
   * fixtures that pre-date the gap-closure run still synth — when absent,
   * the Lambda starts but loadContext's Azure path returns empty semantic
   * chunks (degraded path; matches pre-gap behaviour).
   */
  azureSearchAdminSecret?: ISecret;
  /** Optional override; defaults to 'kos-memory-v2' (matches integrations-azure-indexers default). */
  azureSearchIndexName?: string;
  /**
   * Phase 11 Plan 11-04 part B — voice-to-chat routing.
   * When both are set, voice-capture can HTTP-POST question-shaped
   * transcripts to the Vercel /api/chat proxy and reply via kos.output
   * instead of writing a Notion task. Both optional — when absent the
   * routing silently disables (voice memos flow as captures as before).
   */
  kosChatEndpoint?: string;
  kosDashboardBearerSecret?: ISecret;
}

export class AgentsStack extends Stack {
  public readonly agents: AgentsWiring;

  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);
    this.agents = wireTriageAndVoiceCapture(this, props);
  }
}
