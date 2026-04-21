#!/usr/bin/env node
import 'source-map-support/register';
import { App, Environment, Tags } from 'aws-cdk-lib';
import { RESOLVED_ENV } from '../lib/config/env';

const app = new App();
const env: Environment = RESOLVED_ENV;

// Stacks added by Plans 01-07:
//   NetworkStack       — Plan 01
//   DataStack          — Plan 02
//   EventsStack        — Plan 03
//   IntegrationsStack  — Plans 04, 05, 06
//   SafetyStack        — Plan 07
// `env` is reserved for stack instantiation wiring in later plans.
void env;

Tags.of(app).add('project', 'kos');
Tags.of(app).add('owner', 'kevin');
app.synth();
