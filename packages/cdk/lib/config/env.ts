import type { Environment } from 'aws-cdk-lib';

export const STOCKHOLM_TZ = 'Europe/Stockholm' as const;
export const PRIMARY_REGION = 'eu-north-1' as const;
export const AZURE_SEARCH_REGION = 'westeurope' as const;
export const ALARM_EMAIL = 'kevin@tale-forge.app' as const;
// Kevin's canonical owner UUID (valid RFC 4122 v4, hex-only). STATE.md Locked
// Decision #13. Also the SQL DEFAULT on every owner_id column.
export const OWNER_ID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c' as const;

export const RESOLVED_ENV: Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: PRIMARY_REGION,
};
