import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';

describe('cdk app', () => {
  it('synthesizes empty app without error', () => {
    const app = new App();
    const out = app.synth();
    expect(out).toBeDefined();
  });
});
