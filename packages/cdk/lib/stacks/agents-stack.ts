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
}

export class AgentsStack extends Stack {
  public readonly agents: AgentsWiring;

  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);
    this.agents = wireTriageAndVoiceCapture(this, props);
  }
}
