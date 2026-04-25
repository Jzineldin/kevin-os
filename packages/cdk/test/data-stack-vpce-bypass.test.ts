/**
 * Drift guard for the narrow VPCe-bypass carve-outs in the blobsBucket
 * resource policy (data-stack.ts `DenyAllExceptVpce`).
 *
 * The policy uses CFN-generated role-name patterns (e.g. `KosCapture-*`).
 * If a Lambda is renamed, moved to a different stack, or the stack prefix
 * changes, the bypass silently reverts to DENY — production would break
 * with no test failure.
 *
 * This test synthesises the full stack set that owns the bypassed roles
 * (CaptureStack + DataStack) and asserts each pattern in
 * `DataStack.VPCE_BYPASS_ROLE_PATTERNS` matches at least one live IAM role.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { CaptureStack } from '../lib/stacks/capture-stack';

describe('DataStack VPCe bypass patterns', () => {
  const app = new App();
  const env = { account: '123456789012', region: 'eu-north-1' };
  const net = new NetworkStack(app, 'N', { env });
  const events = new EventsStack(app, 'E', { env });
  const data = new DataStack(app, 'KosData', {
    env,
    vpc: net.vpc,
    s3Endpoint: net.s3GatewayEndpoint,
  });
  // CaptureStack is named `KosCapture` because the bypass patterns depend on
  // that stack prefix being part of the CFN-generated role name.
  const capture = new CaptureStack(app, 'KosCapture', {
    env,
    blobsBucket: data.blobsBucket,
    telegramBotTokenSecret: data.telegramBotTokenSecret,
    telegramWebhookSecret: data.telegramWebhookSecret,
    sentryDsnSecret: data.sentryDsnSecret,
    captureBus: events.buses.capture,
    systemBus: events.buses.system,
    kevinTelegramUserId: '111222333',
  });
  const captureTpl = Template.fromStack(capture);

  it.each(DataStack.VPCE_BYPASS_ROLE_PATTERNS)(
    'role-name pattern %s matches at least one live CaptureStack role',
    (pattern) => {
      // Convert the `{StackName}-{LogicalId}*` pattern into a regex.
      // The `*` suffix stands for the CDK random-hash tail.
      const regex = new RegExp(
        '^' + pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\\\*/g, '.*') + '$',
      );
      const roles = captureTpl.findResources('AWS::IAM::Role');
      // CFN synthesis emits role names via intrinsic functions at deploy time;
      // the template itself only carries logical IDs. The role NAME at runtime
      // is `{StackName}-{LogicalId}{Suffix}-{Hash}`. We compare the pattern's
      // prefix (before `*`) against `{StackName}-{LogicalId}`.
      const patternPrefix = pattern.replace(/\*$/, '');
      const stackName = 'KosCapture';
      const matched = Object.keys(roles).some((logicalId) => {
        const synthesisedName = `${stackName}-${logicalId}`;
        return synthesisedName.startsWith(patternPrefix) || regex.test(synthesisedName);
      });
      expect(matched, `no IAM role in CaptureStack matches pattern "${pattern}"`).toBe(true);
    },
  );
});
