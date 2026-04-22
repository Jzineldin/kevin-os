#!/usr/bin/env node
// Note: source-map-support is not imported here to keep the ESM resolver happy
// under Node 22+. Lambda runtime source maps are enabled via
// `NODE_OPTIONS=--enable-source-maps` (set by KosLambda); this file is only
// used at synth time on the developer workstation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { App, Tags, type Environment } from 'aws-cdk-lib';
import { RESOLVED_ENV } from '../lib/config/env.js';
import { NetworkStack } from '../lib/stacks/network-stack.js';
import { EventsStack } from '../lib/stacks/events-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { IntegrationsStack } from '../lib/stacks/integrations-stack.js';
import { SafetyStack } from '../lib/stacks/safety-stack.js';
import { CaptureStack } from '../lib/stacks/capture-stack.js';
import { AgentsStack } from '../lib/stacks/agents-stack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcribeRegion = (() => {
  try {
    return readFileSync(join(__dirname, '..', '..', '..', 'scripts', '.transcribe-region'), 'utf8').trim();
  } catch {
    return 'eu-north-1';
  }
})();

const app = new App();
const env: Environment = RESOLVED_ENV;

// Stacks added by Plans 01-07:
//   NetworkStack      — Plan 01
//   DataStack         — Plan 02
//   EventsStack       — Plan 03
//   IntegrationsStack — Plans 04, 05, 06
//   SafetyStack       — Plan 07
//   CaptureStack      — Plan 02-01 (CAP-01 Telegram ingress)
const network = new NetworkStack(app, 'KosNetwork', { env });
const events = new EventsStack(app, 'KosEvents', { env });
const data = new DataStack(app, 'KosData', {
  env,
  vpc: network.vpc,
  s3Endpoint: network.s3GatewayEndpoint,
});
const integrations = new IntegrationsStack(app, 'KosIntegrations', {
  env,
  vpc: network.vpc,
  rdsSecret: data.rdsCredentialsSecret,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
  notionTokenSecret: data.notionTokenSecret,
  azureSearchAdminSecret: data.azureSearchAdminSecret,
  blobsBucket: data.blobsBucket,
  transcribeRegion,
  captureBus: events.buses.capture,
  systemBus: events.buses.system,
  scheduleGroupName: events.scheduleGroupName,
});
void integrations;

const safety = new SafetyStack(app, 'KosSafety', {
  env,
  rdsSecret: data.rdsCredentialsSecret,
  rdsProxyEndpoint: data.rdsProxyEndpoint,
  telegramBotTokenSecret: data.telegramBotTokenSecret,
  // Plan 02-06: push-telegram consumes output.push events from kos.output.
  outputBus: events.buses.output,
});
// Plan 02-06: SafetyStack now takes a reference to the kos.output bus,
// so it depends on EventsStack. addDependency keeps `cdk deploy` order
// correct (EventsStack provisions the bus before SafetyStack's rule).
safety.addDependency(events);
void safety;

// CaptureStack — Plan 02-01 (CAP-01 Telegram ingress).
// KEVIN_TELEGRAM_USER_ID is supplied at synth time via env var or CDK context.
const capture = new CaptureStack(app, 'KosCapture', {
  env,
  blobsBucket: data.blobsBucket,
  telegramBotTokenSecret: data.telegramBotTokenSecret,
  telegramWebhookSecret: data.telegramWebhookSecret,
  sentryDsnSecret: data.sentryDsnSecret,
  captureBus: events.buses.capture,
  systemBus: events.buses.system,
  kevinTelegramUserId:
    process.env.KEVIN_TELEGRAM_USER_ID ??
    (app.node.tryGetContext('kevinTelegramUserId') as string | undefined) ??
    '',
});
capture.addDependency(data);
capture.addDependency(events);
void capture;

// AgentsStack — Plan 02-04 (AGT-01 triage + AGT-02 voice-capture).
// KEVIN_OWNER_ID is the single-user UUID Kevin operates as; supplied via
// env var or CDK context at synth time.
const agents = new AgentsStack(app, 'KosAgents', {
  env,
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
  kevinOwnerId:
    process.env.KEVIN_OWNER_ID ??
    (app.node.tryGetContext('kevinOwnerId') as string | undefined) ??
    '',
});
agents.addDependency(data);
agents.addDependency(events);
agents.addDependency(integrations); // commandCenter ID source-of-truth
void agents;

Tags.of(app).add('project', 'kos');
Tags.of(app).add('owner', 'kevin');
app.synth();
