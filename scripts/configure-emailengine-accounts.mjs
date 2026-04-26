#!/usr/bin/env node
/**
 * Operator script: register both Gmail accounts with EmailEngine via the
 * emailengine-admin Lambda Function URL (Plan 04-03 Task 8).
 *
 * Run AFTER:
 *   1. Operator has procured an EmailEngine license (~$99/yr at postalsys.com).
 *   2. Operator has created Gmail app passwords for both kevin.elzarka@gmail.com
 *      and kevin@tale-forge.app via myaccount.google.com → Security → 2-Step
 *      Verification → App passwords.
 *   3. All 5 EmailEngine secrets are seeded in Secrets Manager (license,
 *      both imap-* JSON blobs, webhook-secret, api-key).
 *   4. `cdk deploy KosIntegrations` with `enableEmailEngine=true` has run
 *      and the Fargate task is HEALTHY.
 *
 * Required env vars:
 *   EMAILENGINE_ADMIN_URL         — Function URL from CFN output (KosIntegrations-EmailEngineAdminUrl).
 *   IMAP_SECRET_ARN_ELZARKA       — ARN of kos/emailengine-imap-kevin-elzarka.
 *   IMAP_SECRET_ARN_TALEFORGE     — ARN of kos/emailengine-imap-kevin-taleforge.
 *
 * Usage:
 *   export EMAILENGINE_ADMIN_URL=$(aws cloudformation describe-stacks --stack-name KosIntegrations \
 *     --query "Stacks[0].Outputs[?OutputKey=='EmailEngineAdminUrl'].OutputValue" --output text)
 *   export IMAP_SECRET_ARN_ELZARKA=$(aws secretsmanager describe-secret \
 *     --secret-id kos/emailengine-imap-kevin-elzarka --query ARN --output text)
 *   export IMAP_SECRET_ARN_TALEFORGE=$(aws secretsmanager describe-secret \
 *     --secret-id kos/emailengine-imap-kevin-taleforge --query ARN --output text)
 *   node scripts/configure-emailengine-accounts.mjs
 *
 * The Function URL is `authType=AWS_IAM`; we invoke the underlying Lambda
 * by name via `aws lambda invoke` (the operator's IAM creds sign the
 * request automatically — no client-side SigV4 plumbing needed).
 */
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

const ADMIN_URL = process.env.EMAILENGINE_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'Set EMAILENGINE_ADMIN_URL (from cfn output KosIntegrations-EmailEngineAdminUrl).',
  );
  process.exit(1);
}

const ACCOUNTS = [
  {
    id: 'kevin-elzarka',
    secretArn: process.env.IMAP_SECRET_ARN_ELZARKA,
    label: 'kevin.elzarka@gmail.com',
  },
  {
    id: 'kevin-taleforge',
    secretArn: process.env.IMAP_SECRET_ARN_TALEFORGE,
    label: 'kevin@tale-forge.app',
  },
];

for (const a of ACCOUNTS) {
  if (!a.secretArn) {
    console.error(`Missing secretArn env for ${a.id} (${a.label})`);
    process.exit(1);
  }
}

// Derive Lambda function name from the Function URL.
//   https://<id>.lambda-url.<region>.on.aws/  →  function name lookup via
//   aws lambda get-function-url-config requires the function name, so we
//   instead use the URL host ID lookup via aws lambda list-function-url-configs.
//
// Simpler: ask CloudFormation directly. The function logical id is
// `EmailEngineAdmin`; CFN names it `KosIntegrations-EmailEngineAdmin-<hash>`.
function resolveLambdaName() {
  const out = execSync(
    `aws cloudformation describe-stack-resource --stack-name KosIntegrations --logical-resource-id EmailEngineAdmin --query 'StackResourceDetail.PhysicalResourceId' --output text`,
    { encoding: 'utf8' },
  ).trim();
  if (!out) {
    throw new Error('Failed to resolve EmailEngineAdmin physical resource id');
  }
  return out;
}

const fnName = resolveLambdaName();
console.log(`emailengine-admin Lambda: ${fnName}`);

const tmp = '/tmp/ee-admin-out.json';
for (const a of ACCOUNTS) {
  console.log(`\nRegistering ${a.id} (${a.label})...`);
  const payload = JSON.stringify({
    body: JSON.stringify({
      command: 'register-account',
      account: a.id,
      accountSecretArn: a.secretArn,
    }),
    requestContext: { http: { method: 'POST' } },
    isBase64Encoded: false,
  });
  const payloadFile = `/tmp/ee-payload-${a.id}.json`;
  writeFileSync(payloadFile, payload);
  try {
    execSync(
      `aws lambda invoke --function-name ${fnName} --cli-binary-format raw-in-base64-out --payload file://${payloadFile} ${tmp}`,
      { stdio: 'inherit' },
    );
    if (existsSync(tmp)) {
      const body = readFileSync(tmp, 'utf8');
      console.log(`Response: ${body}`);
      unlinkSync(tmp);
    }
  } finally {
    if (existsSync(payloadFile)) unlinkSync(payloadFile);
  }
}

console.log(
  '\nDone. Watch IMAP IDLE start: aws logs tail /ecs/emailengine --follow',
);
console.log(
  'Expect "IMAP IDLE established" within ~30s per account. If you see',
);
console.log(
  '"auth failure" — the Gmail app password is wrong or 2FA is not enabled.',
);
