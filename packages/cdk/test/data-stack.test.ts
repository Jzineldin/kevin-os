import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';

/**
 * DataStack synth-level assertions.
 *
 * Covers:
 *  - RDS engine version, instance class, single-AZ, deletion protection
 *    (D-03, D-07 + RESEARCH Pitfall 4)
 *  - Blobs bucket public-access block + SSL enforcement (T-01-S3-01)
 *  - RDS DeletionPolicy: Retain (D-03)
 *  - 10+ Secrets Manager placeholders (RDS generated secret + 4 Phase-1 + 6 Phase-2 app secrets)
 */
describe('DataStack', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const data = new DataStack(app, 'D', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const tpl = Template.fromStack(data);

  it('creates RDS Postgres 16.5 db.t4g.medium single-AZ', () => {
    tpl.hasResourceProperties(
      'AWS::RDS::DBInstance',
      Match.objectLike({
        Engine: 'postgres',
        // Accept 16.5 or any higher 16.x minor so minor-version bumps don't
        // fail the test.
        EngineVersion: Match.stringLikeRegexp('^16\\.(5|[6-9]|[1-9][0-9])'),
        DBInstanceClass: 'db.t4g.medium',
        MultiAZ: false,
        DeletionProtection: true,
      }),
    );
  });

  it('RDS has RETAIN DeletionPolicy (D-03)', () => {
    tpl.hasResource(
      'AWS::RDS::DBInstance',
      Match.objectLike({ DeletionPolicy: 'Retain' }),
    );
  });

  it('RDS parameter group pins rds.force_ssl = 1', () => {
    tpl.hasResourceProperties(
      'AWS::RDS::DBParameterGroup',
      Match.objectLike({
        Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
      }),
    );
  });

  it('blobs bucket has BlockPublicAccess all-on', () => {
    tpl.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        }),
      }),
    );
  });

  it('blobs bucket policy denies non-VPCe traffic (aws:SourceVpce)', () => {
    const policies = tpl.findResources('AWS::S3::BucketPolicy');
    const vpceDeny = Object.values(policies).some((p) => {
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const s = stmt as { Effect?: string; Condition?: Record<string, unknown> };
        if (s.Effect !== 'Deny' || !s.Condition) return false;
        const flat = JSON.stringify(s.Condition);
        return flat.includes('aws:SourceVpce');
      });
    });
    expect(vpceDeny).toBe(true);
  });

  it('creates at least 11 Secrets Manager entries (RDS-generated + 4 Phase-1 + 6 Phase-2)', () => {
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    // RDS-generated credentials secret + 4 Phase-1 placeholders + 6 Phase-2
    // placeholders = >= 11. Asserting the stricter local count so accidental
    // drop of one placeholder fails the test.
    expect(Object.keys(secrets).length).toBeGreaterThanOrEqual(11);
  });

  it('exposes the 4 Phase-1 named application secrets by SecretName', () => {
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (s) => (s as { Properties?: { Name?: string } }).Properties?.Name,
    );
    for (const expected of [
      'kos/notion-token',
      'kos/azure-search-admin',
      'kos/telegram-bot-token',
      'kos/dashboard-bearer',
    ]) {
      expect(names, `missing secret ${expected}`).toContain(expected);
    }
  });

  it('exposes the 6 Phase-2 named application secrets by SecretName', () => {
    const secrets = tpl.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map(
      (s) => (s as { Properties?: { Name?: string } }).Properties?.Name,
    );
    for (const expected of [
      'kos/langfuse-public-key',
      'kos/langfuse-secret-key',
      'kos/sentry-dsn',
      'kos/telegram-webhook-secret',
      'kos/granola-api-key',
      'kos/gmail-oauth-tokens',
    ]) {
      expect(names, `missing secret ${expected}`).toContain(expected);
    }
  });

  it('bastion is NOT created without --context bastion=true', () => {
    tpl.resourceCountIs('AWS::EC2::Instance', 0);
  });
});

describe('DataStack with bastion context', () => {
  const app = new App({ context: { bastion: 'true' } });
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N2', { env });
  const data = new DataStack(app, 'D2', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  const tpl = Template.fromStack(data);

  it('creates exactly one bastion EC2 instance', () => {
    tpl.resourceCountIs('AWS::EC2::Instance', 1);
  });
});
