# Deferred Items (Phase 01-infrastructure-foundation)

## Resolved

### ~~Pre-existing CDK typecheck errors in Wave 3 test files~~ — RESOLVED 2026-04-22

**Files:**
- `packages/cdk/test/integrations-stack-azure.test.ts`
- `packages/cdk/test/integrations-stack-notion.test.ts`

**Was:** `IntegrationsStack` was extended (Wave 3 merge of Plans 04, 05, 06)
to require additional props. Two test files were not updated to pass the new
required props.

**Fix:** Added `vpc`, `rdsSecret`, `rdsProxyEndpoint`, `rdsProxyDbiResourceId`,
`notionTokenSecret`, `captureBus`, `systemBus`, `scheduleGroupName` to the
azure test file; added `azureSearchAdminSecret` to the notion test file.
Commit `2f20e5c`.

**Verification:** `pnpm --filter @kos/cdk test -- --run` → 51/51 passed.
`pnpm --filter @kos/cdk typecheck` → clean.

