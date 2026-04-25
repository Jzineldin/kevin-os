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
import { IntegrationsStack } from '../lib/stacks/integrations-stack';

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
  // IntegrationsStack is the host for the Phase 4 Plan 04-01 ios-webhook
  // Lambda — its CFN role name carries the `KosIntegrations-IosWebhook*`
  // prefix that the bypass policy depends on.
  const integrations = new IntegrationsStack(app, 'KosIntegrations', {
    env,
    vpc: net.vpc,
    rdsSecurityGroup: data.rdsSecurityGroup,
    rdsSecret: data.rdsCredentialsSecret,
    rdsProxyEndpoint: data.rdsProxyEndpoint,
    rdsProxyDbiResourceId: data.rdsProxyDbiResourceId,
    notionTokenSecret: data.notionTokenSecret,
    captureBus: events.buses.capture,
    systemBus: events.buses.system,
    scheduleGroupName: events.scheduleGroupName,
    azureSearchAdminSecret: data.azureSearchAdminSecret,
    blobsBucket: data.blobsBucket,
    iosShortcutWebhookSecret: data.iosShortcutWebhookSecret,
  });
  const captureTpl = Template.fromStack(capture);
  const integrationsTpl = Template.fromStack(integrations);

  it.each(DataStack.VPCE_BYPASS_ROLE_PATTERNS)(
    'role-name pattern %s matches at least one live role across CaptureStack or IntegrationsStack',
    (pattern) => {
      const patternPrefix = pattern.replace(/\*$/, '');
      const matchInStack = (tpl: Template, stackName: string): boolean => {
        const roles = tpl.findResources('AWS::IAM::Role');
        return Object.keys(roles).some((logicalId) =>
          `${stackName}-${logicalId}`.startsWith(patternPrefix),
        );
      };
      const matched =
        matchInStack(captureTpl, 'KosCapture') ||
        matchInStack(integrationsTpl, 'KosIntegrations');
      expect(
        matched,
        `no IAM role in CaptureStack or IntegrationsStack matches pattern "${pattern}"`,
      ).toBe(true);
    },
  );
});
