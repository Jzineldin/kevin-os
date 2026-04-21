#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags, type Environment } from 'aws-cdk-lib';
import { RESOLVED_ENV } from '../lib/config/env';
import { NetworkStack } from '../lib/stacks/network-stack';

const app = new App();
const env: Environment = RESOLVED_ENV;

// Stacks added by Plans 01-07:
//   NetworkStack      — Plan 01 (this plan)
//   DataStack         — Plan 02
//   EventsStack       — Plan 03
//   IntegrationsStack — Plans 04, 05, 06
//   SafetyStack       — Plan 07
const network = new NetworkStack(app, 'KosNetwork', { env });
// `network` referenced by DataStack (Plan 02) via props { vpc: network.vpc, s3Endpoint: network.s3GatewayEndpoint }.
void network;

Tags.of(app).add('project', 'kos');
Tags.of(app).add('owner', 'kevin');
app.synth();
