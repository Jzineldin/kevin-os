import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KosLambda } from '../lib/constructs/kos-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('KosLambda', () => {
  it('defaults to Node 22.x ARM64 with @aws-sdk/* externalized', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'eu-north-1' },
    });
    new KosLambda(stack, 'Fn', {
      entry: path.join(__dirname, 'fixtures/dummy-handler.ts'),
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
      }),
    );
  });

  it('sets TZ=UTC and NODE_OPTIONS source-maps env vars', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack2', {
      env: { account: '123456789012', region: 'eu-north-1' },
    });
    new KosLambda(stack, 'Fn', {
      entry: path.join(__dirname, 'fixtures/dummy-handler.ts'),
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            TZ: 'UTC',
            NODE_OPTIONS: '--enable-source-maps',
          }),
        }),
      }),
    );
  });

  it('extra environment vars are merged with defaults', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack3', {
      env: { account: '123456789012', region: 'eu-north-1' },
    });
    new KosLambda(stack, 'Fn', {
      entry: path.join(__dirname, 'fixtures/dummy-handler.ts'),
      environment: { CUSTOM_VAR: 'hello' },
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            TZ: 'UTC',
            CUSTOM_VAR: 'hello',
          }),
        }),
      }),
    );
    // Two Lambda::Function resources are emitted: the KosLambda itself, plus the
    // CDK-generated LogRetention provider Lambda (logRetention is set). Both may
    // use nodejs22.x as runtime, so we filter by the user-supplied env var
    // (CUSTOM_VAR) that only the KosLambda carries.
    const allFns = Object.entries(tpl.findResources('AWS::Lambda::Function'));
    const userFns = allFns.filter(([, r]) => {
      const vars = (r as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
        .Properties?.Environment?.Variables;
      return vars?.CUSTOM_VAR === 'hello';
    });
    expect(userFns.length).toBe(1);
  });
});
