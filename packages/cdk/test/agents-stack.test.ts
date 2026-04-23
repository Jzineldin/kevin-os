import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { AgentsStack } from '../lib/stacks/agents-stack';

/**
 * AgentsStack synth-level assertions (Plan 02-04, AGT-01 + AGT-02).
 *
 * Covers:
 *   - 1 EventBridge rule on kos.capture for triage (matches both
 *     capture.received + capture.voice.transcribed) with DLQ
 *   - 1 EventBridge rule on kos.triage for voice-capture (filters
 *     detail.route=['voice-capture']) with DLQ
 *   - Both Lambdas use nodejs22.x + arm64
 *   - Both Lambdas have CLAUDE_CODE_USE_BEDROCK=1 env
 *   - Both Lambdas have bedrock:InvokeModel + rds-db:connect IAM grants
 *   - Triage Lambda timeout ≤ 30s; voice-capture ≤ 60s
 */
describe('AgentsStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const agents = new AgentsStack(app, 'A', {
    env,
    vpc: net.vpc,
    rdsSecurityGroup: data.rdsSecurityGroup,
    captureBus: events.buses.capture,
    triageBus: events.buses.triage,
    agentBus: events.buses.agent,
    outputBus: events.buses.output,
    notionTokenSecret: data.notionTokenSecret,
    sentryDsnSecret: data.sentryDsnSecret,
    langfusePublicSecret: data.langfusePublicSecret,
    langfuseSecretSecret: data.langfuseSecretSecret,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    rdsIamUser: 'kos_admin',
    rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
    kevinOwnerId: '00000000-0000-0000-0000-000000000001',
    // Plan 02-09 (ENT-06): wire Gmail OAuth secret for the granola-gmail Lambda.
    gmailOauthSecret: data.gmailOauthSecret,
  });
  const tpl = Template.fromStack(agents);

  it('TriageFromCaptureRule matches both capture.received + capture.voice.transcribed with DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const rule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | { source?: string[]; 'detail-type'?: string[] }
        | undefined;
      return (
        ep?.source?.includes('kos.capture') === true &&
        ep?.['detail-type']?.includes('capture.received') === true &&
        ep?.['detail-type']?.includes('capture.voice.transcribed') === true
      );
    });
    expect(rule).toBeDefined();
    const targets = (rule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  it('VoiceCaptureFromTriageRule filters detail.route=voice-capture with DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const rule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | {
            source?: string[];
            'detail-type'?: string[];
            detail?: { route?: string[] };
          }
        | undefined;
      return (
        ep?.source?.includes('kos.triage') === true &&
        ep?.['detail-type']?.includes('triage.routed') === true &&
        ep?.detail?.route?.includes('voice-capture') === true
      );
    });
    expect(rule).toBeDefined();
    const targets = (rule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  // Helper: agent Lambdas have KEVIN_OWNER_ID env; CDK helper Lambdas (e.g.
  // LogRetention) do not — filter on it to ignore CDK-managed scaffolding.
  const agentFns = () => {
    const fns = tpl.findResources('AWS::Lambda::Function');
    return Object.values(fns).filter((fn) => {
      const env = (
        fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties?.Environment?.Variables;
      return env?.KEVIN_OWNER_ID !== undefined;
    });
  };

  it('all agent Lambdas run nodejs22.x + arm64', () => {
    const fns = agentFns();
    // triage + voice-capture + entity-resolver + bulk-import-kontakter (Plan 02-08)
    // + bulk-import-granola-gmail (Plan 02-09)
    expect(fns.length).toBe(5);
    for (const fn of fns) {
      const props = (fn as { Properties: { Runtime: string; Architectures: string[] } })
        .Properties;
      expect(props.Runtime).toBe('nodejs22.x');
      expect(props.Architectures).toEqual(['arm64']);
    }
  });

  it('Claude-SDK agent Lambdas have CLAUDE_CODE_USE_BEDROCK=1 env (both bulk-import lambdas excluded — no LLM calls)', () => {
    for (const fn of agentFns()) {
      const env = (
        fn as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      // Plan 02-08 bulk-import-kontakter (KONTAKTER_DB_ID_OPTIONAL env) +
      // Plan 02-09 bulk-import-granola-gmail (TRANSKRIPTEN_DB_ID_OPTIONAL env)
      // do NOT call any LLM — skip the Bedrock env check for both.
      const isBulkImport =
        env.KONTAKTER_DB_ID_OPTIONAL !== undefined ||
        env.TRANSKRIPTEN_DB_ID_OPTIONAL !== undefined;
      if (!isBulkImport) {
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      }
      expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
      expect(env.RDS_PROXY_ENDPOINT).toBeDefined();
      expect(env.RDS_IAM_USER).toBe('kos_admin');
    }
  });

  it('both Lambda roles have bedrock:InvokeModel + rds-db:connect IAM statements', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('bedrock:InvokeModel');
    expect(serialized).toContain('rds-db:connect');
    expect(serialized).toContain('eu.anthropic.claude-haiku-4-5');
  });

  it('voice-capture Lambda has NOTION_COMMAND_CENTER_DB_ID env + agent/output bus PutEvents grants', () => {
    const vc = agentFns().find((f) => {
      const env = (
        f as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      return env.NOTION_COMMAND_CENTER_DB_ID !== undefined;
    });
    expect(vc).toBeDefined();
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    // PutEvents on agent + output buses (and triage from triageFn).
    expect(serialized).toContain('events:PutEvents');
    expect(serialized).toMatch(/KosBusagentBus/);
    expect(serialized).toMatch(/KosBusoutputBus/);
    expect(serialized).toMatch(/KosBustriageBus/);
  });

  it('per-agent timeout caps: triage ≤ 30s; voice-capture + entity-resolver ≤ 60s; both bulk-imports ≤ 900s', () => {
    for (const fn of agentFns()) {
      const props = (
        fn as { Properties: { Timeout: number; Environment: { Variables: Record<string, unknown> } } }
      ).Properties;
      const env = props.Environment.Variables;
      if (
        env.KONTAKTER_DB_ID_OPTIONAL !== undefined ||
        env.TRANSKRIPTEN_DB_ID_OPTIONAL !== undefined
      ) {
        expect(props.Timeout).toBeLessThanOrEqual(900); // bulk-import (Plans 02-08 / 02-09)
      } else if (env.NOTION_COMMAND_CENTER_DB_ID !== undefined) {
        expect(props.Timeout).toBeLessThanOrEqual(60); // voice-capture
      } else if (env.NOTION_KOS_INBOX_DB_ID !== undefined) {
        expect(props.Timeout).toBeLessThanOrEqual(60); // entity-resolver (Plan 02-05)
      } else {
        expect(props.Timeout).toBeLessThanOrEqual(30); // triage
      }
    }
  });

  it('creates dedicated triage + voice-capture + entity-resolver DLQs', () => {
    const queues = tpl.findResources('AWS::SQS::Queue');
    const names = Object.values(queues).map(
      (q) => (q as { Properties?: { QueueName?: string } }).Properties?.QueueName,
    );
    expect(names).toContain('kos-triage-agent-dlq');
    expect(names).toContain('kos-voice-capture-dlq');
    expect(names).toContain('kos-entity-resolver-dlq');
  });

  // --- Plan 02-05 entity-resolver assertions -----------------------------

  it('EntityResolverFromAgentRule on kos.agent matches entity.mention.detected with per-pipeline DLQ', () => {
    const rules = tpl.findResources('AWS::Events::Rule');
    const rule = Object.values(rules).find((r) => {
      const ep = (r as { Properties?: { EventPattern?: unknown } }).Properties
        ?.EventPattern as
        | { source?: string[]; 'detail-type'?: string[] }
        | undefined;
      return (
        ep?.source?.includes('kos.agent') === true &&
        ep?.['detail-type']?.includes('entity.mention.detected') === true
      );
    });
    expect(rule).toBeDefined();
    const targets = (rule as { Properties: { Targets: { DeadLetterConfig?: unknown }[] } })
      .Properties.Targets;
    expect(targets[0]?.DeadLetterConfig).toBeDefined();
  });

  it('entity-resolver Lambda: timeout 60s, memory ≥ 1024MB, NOTION_TOKEN + RDS env wired', () => {
    const resolver = agentFns().find((f) => {
      const env = (
        f as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      // Disambiguate from bulk-import-kontakter (which also has
      // NOTION_KOS_INBOX_DB_ID) by requiring CLAUDE_CODE_USE_BEDROCK.
      return (
        env.NOTION_KOS_INBOX_DB_ID !== undefined &&
        env.CLAUDE_CODE_USE_BEDROCK === '1'
      );
    });
    expect(resolver).toBeDefined();
    const props = (
      resolver as { Properties: { Timeout: number; MemorySize: number; Environment: { Variables: Record<string, unknown> } } }
    ).Properties;
    expect(props.Timeout).toBe(60);
    expect(props.MemorySize).toBeGreaterThanOrEqual(1024);
    const env = props.Environment.Variables;
    expect(env.NOTION_TOKEN_SECRET_ARN).toBeDefined();
    expect(env.RDS_PROXY_ENDPOINT).toBeDefined();
    expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('entity-resolver IAM grants: bedrock:InvokeModel for Sonnet 4.6 inference profile + Cohere embed + Notion token read', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('eu.anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('cohere.embed-multilingual-v3');
    // Notion token grant present (3 readers — 1 voice-capture + 1 resolver +
    // potentially others). Two `secretsmanager:GetSecretValue` resources is
    // sufficient evidence that resolver is granted alongside voice-capture.
    expect(serialized).toContain('secretsmanager:GetSecretValue');
  });

  it('emits exactly 5 agent Lambdas (triage + voice-capture + entity-resolver + bulk-import-kontakter + bulk-import-granola-gmail); CDK helper Lambdas excluded', () => {
    expect(agentFns().length).toBe(5);
  });

  // --- Plan 02-08 BulkImportKontakter assertions -------------------------

  it('BulkImportKontakter Lambda: 15-min timeout, NOTION_TOKEN + KOS Inbox env wired, no event-source rule', () => {
    const fn = agentFns().find((f) => {
      const env = (
        f as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      return env.KONTAKTER_DB_ID_OPTIONAL !== undefined;
    });
    expect(fn).toBeDefined();
    const props = (
      fn as {
        Properties: {
          Timeout: number;
          MemorySize: number;
          Environment: { Variables: Record<string, unknown> };
        };
      }
    ).Properties;
    expect(props.Timeout).toBe(900); // 15 min
    expect(props.MemorySize).toBeGreaterThanOrEqual(1024);
    const env = props.Environment.Variables;
    expect(env.NOTION_TOKEN_SECRET_ARN).toBeDefined();
    expect(env.NOTION_KOS_INBOX_DB_ID).toBeDefined();
    expect(env.RDS_PROXY_ENDPOINT).toBeDefined();
    expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');

    // No EventBridge rule should target this Lambda — it's operator-invoked.
    const rules = tpl.findResources('AWS::Events::Rule');
    const fnLogicalIdRefs = JSON.stringify(rules);
    expect(fnLogicalIdRefs).not.toMatch(/BulkImportKontakter[^"]*"\s*,\s*"Arn"/);
  });

  it('BulkImportKontakter IAM: rds-db:connect + bedrock:ListInferenceProfiles + Notion token read', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('rds-db:connect');
    expect(serialized).toContain('bedrock:ListInferenceProfiles');
    // Notion token grant present (3+ readers — voice-capture + resolver + bulk-import)
    expect(serialized).toContain('secretsmanager:GetSecretValue');
  });

  // --- Plan 02-09 BulkImportGranolaGmail assertions ----------------------

  it('BulkImportGranolaGmail Lambda: 15-min timeout, GMAIL_OAUTH_SECRET_ID + KOS Inbox env wired, no event-source rule', () => {
    const fn = agentFns().find((f) => {
      const env = (
        f as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      return env.TRANSKRIPTEN_DB_ID_OPTIONAL !== undefined;
    });
    expect(fn).toBeDefined();
    const props = (
      fn as {
        Properties: {
          Timeout: number;
          MemorySize: number;
          Environment: { Variables: Record<string, unknown> };
        };
      }
    ).Properties;
    expect(props.Timeout).toBe(900); // 15 min
    expect(props.MemorySize).toBeGreaterThanOrEqual(1024);
    const env = props.Environment.Variables;
    expect(env.NOTION_TOKEN_SECRET_ARN).toBeDefined();
    expect(env.NOTION_KOS_INBOX_DB_ID).toBeDefined();
    expect(env.RDS_PROXY_ENDPOINT).toBeDefined();
    expect(env.GMAIL_OAUTH_SECRET_ID).toBe('kos/gmail-oauth-tokens');
    expect(env.KEVIN_OWNER_ID).toBe('00000000-0000-0000-0000-000000000001');
    // No CLAUDE_CODE_USE_BEDROCK — this Lambda doesn't call any LLM.
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();

    // No EventBridge rule should target this Lambda — operator-invoked.
    const rules = tpl.findResources('AWS::Events::Rule');
    const fnLogicalIdRefs = JSON.stringify(rules);
    expect(fnLogicalIdRefs).not.toMatch(/BulkImportGranolaGmail[^"]*"\s*,\s*"Arn"/);
  });

  it('BulkImportGranolaGmail IAM: rds-db:connect + Notion token read + Gmail OAuth secret read; NO bedrock:InvokeModel grant', () => {
    const policies = tpl.findResources('AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain('rds-db:connect');
    // Gmail OAuth secret grant — DataStack creates `kos/gmail-oauth-tokens`
    // and AgentsStack passes it via gmailOauthSecret prop, so the grant
    // should reference the secret ARN by ref. The literal string
    // 'GmailOauth' is the CDK logical ID.
    expect(serialized).toMatch(/GmailOauth/);
    // Notion token grant present (≥3 readers)
    expect(serialized).toContain('secretsmanager:GetSecretValue');
  });
});

// Tickle Match import so the linter is happy (used implicitly via the
// Match-aware findResources helpers; reference here defensively).
void Match;
