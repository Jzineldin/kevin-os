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

Tags.of(app).add('project', 'kos');
Tags.of(app).add('owner', 'kevin');
app.synth();
