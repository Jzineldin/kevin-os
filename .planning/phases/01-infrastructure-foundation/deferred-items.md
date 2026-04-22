# Deferred Items (Phase 01-infrastructure-foundation)

## Out-of-scope pre-existing issues discovered during plan 01-07

### Pre-existing CDK typecheck errors in Wave 3 test files

**File:** `packages/cdk/test/integrations-stack-azure.test.ts:29`
**File:** `packages/cdk/test/integrations-stack-notion.test.ts:31`

**Error:** `IntegrationsStack` was extended (Wave 3 merge of Plans 04, 05, 06)
to require additional props (`azureSearchAdminSecret`, `vpc`, `rdsSecret`,
etc.) but these two test files were not updated to pass the new required
props.

**Confirmed pre-existing:** Reproduced by `git stash && pnpm --filter @kos/cdk
typecheck` at base `ba7f3636` before Plan 01-07 changes were applied. Plan
01-07 did not introduce these errors.

**Scope boundary:** Out of scope for Plan 01-07. Log only; do not fix here.
The `integrations-stack-vocab.test.ts` file (also Wave 3) was updated during
the Plan 01-06 merge and does pass; the azure + notion companions should be
patched in a Wave 3 cleanup task or the next IntegrationsStack plan.

**Impact on Plan 01-07 verification:** `pnpm --filter @kos/cdk test -- --run
safety-stack` succeeds (all 8 tests pass). `npx cdk synth KosSafety --quiet`
succeeds. The new `safety-stack.ts` + `safety-stack.test.ts` are
type-clean in isolation — the failing files are unrelated test fixtures
for other stacks.
