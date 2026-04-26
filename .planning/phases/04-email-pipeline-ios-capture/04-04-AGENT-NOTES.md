# Plan 04-04 — AGT-05 email-triage Lambda — agent execution notes

## File list + line counts

### Lambda source (`services/email-triage/src/`)
| File | LoC | Purpose |
|------|-----|---------|
| `classify.ts`        | 243 | Haiku 4.5 tool_use classify (urgent/important/informational/junk) + escapeEmailContent + Zod schema + safe fallback on model garbage |
| `draft.ts`           | 204 | Sonnet 4.6 tool_use draft (urgent only) + Zod schema + safe fallback |
| `context.ts`         | 140 | loadTriageContext — tries `@kos/context-loader`, degrades to local Kevin Context loader on import error or runtime failure |
| `persist.ts`         | 221 | RDS Proxy IAM-auth pool + idempotent `INSERT … ON CONFLICT DO NOTHING` against email_drafts + status updates + pending-row scan |
| `resolveEntities.ts` |  54 | entity_index lookup by email; resilient to missing `email text[]` column (returns []) |
| `handler.ts`         | 327 | EventBridge dispatch on 3 event paths (capture.received[email_inbox], capture.received[email_forward], scan_emails_now) + withTimeoutAndRetry wrapping every Bedrock call + draft_ready emit on kos.output |

### Lambda tests (`services/email-triage/test/`)
| File | LoC | Tests |
|------|-----|-------|
| `classify.test.ts`           | 189 | 8 — benign, adversarial, wrap, escape, model-garbage fallback, model-id pin, cache_control on 3 segments, empty Kevin block dropped |
| `draft.test.ts`              | 119 | 5 — valid output, reply_to mirror, wrap, model-id pin, model-garbage fallback |
| `context-fallback.test.ts`   |  86 | 3 — context-loader resolved, unresolvable→degraded, shape contract |
| `idempotency.test.ts`        | 101 | 3 — findExisting hit, conflict re-SELECT, dup-fixture twice → same id |
| `handler.test.ts`            | 279 | 6 — email_inbox urgent path, email_forward mapping, scan_emails_now iteration, dup → same draft id, non-urgent no-emit, adversarial no-draft no-emit |

### CDK (`packages/cdk/`)
| File | LoC | Purpose |
|------|-----|---------|
| `lib/stacks/integrations-email-agents.ts` | 222 | wireEmailAgents helper — KosLambda + Bedrock IAM (Haiku+Sonnet+Cohere v4 EU) + rds-db:connect + outputBus PutEvents + 2 EventBridge rules + DLQ |
| `test/integrations-email-agents.test.ts`  | 202 | 8 assertions including SES-absent drift detection (test 5) |

### Integration into existing files
- `packages/cdk/lib/stacks/integrations-stack.ts`: import + public `emailAgents?: EmailAgentsWiring` field + `wireEmailAgents(...)` call gated on `props.outputBus && props.kevinOwnerId`.

**Total new LoC**: 2,387 (sources + tests + CDK).

## Verification outputs

```
pnpm --filter @kos/service-email-triage typecheck   → clean
pnpm --filter @kos/service-email-triage test        → 25/25 PASS
  · test/classify.test.ts (8 tests)
  · test/draft.test.ts (5 tests)
  · test/context-fallback.test.ts (3 tests)
  · test/idempotency.test.ts (3 tests)
  · test/handler.test.ts (6 tests)

pnpm --filter @kos/cdk typecheck                    → clean
npx vitest run integrations-email-agents (in CDK)   → 8/8 PASS
npx vitest run integrations-stack (in CDK)          → 19/19 PASS (no regressions in existing tests)
```

Full CDK test suite run (528 s) had `178 passed / 1 failed` before the
final fix — failure was the OUTPUT_BUS_NAME literal-vs-Ref assertion
in the new email-agents test. Fixed and re-verified by running just
the email-agents file (8/8 PASS) plus the integrations-stack files
(19/19 PASS).

## Key implementation decisions / deviations

1. **Per-bus name handling for OUTPUT_BUS_NAME env var**: the value is a
   CDK Token at synth time, not a literal. The test asserts the Ref shape
   rather than the literal string ("kos.output"). Documented inline.

2. **DUPLICATE_EMAIL_FIXTURES capture_ids violate ULID Crockford alphabet**
   (they contain literal `U`). The handler test rebuilds the same shape with
   valid ULIDs that share the same (account_id, message_id) — the Gate 3
   idempotency property is preserved, but the fixture itself can't be parsed
   by `CaptureReceivedEmailInboxSchema` directly. **Suggest fixture fix in a
   future plan**: regenerate DU1/DU2 with values from the
   `[0-9A-HJKMNP-TV-Z]` alphabet.

3. **scan_emails_now path**: re-classifies pending rows but synthesises
   `body_text=''` because email_drafts does NOT store the raw body (per
   migration 0016 schema). Sufficient for re-classification of subject +
   sender, which is the operator use case. Documented as a known limitation.

4. **No Notion writes**: the plan explicitly directs drafts to RDS
   (`email_drafts` table). Notion is wired only for the optional secret
   read in case Phase 5 dashboard chooses to mirror.

5. **Cohere v4 IAM**: granted on `email-triage` only when
   `azureSearchAdminSecret` is supplied — same conditional pattern used in
   `integrations-agents.ts` for the existing 4 consumer Lambdas.

6. **`@kos/context-loader` graceful degrade**: import is dynamic; if the
   module is absent OR `loadContext()` throws, the Lambda falls back to the
   local Kevin-Context-only path via `loadKevinContextBlockLocal`. Both
   paths return the same `TriageContext` shape with `degraded: boolean`.

7. **No new migration written**: the plan called for an optional
   `0017_email_triage_role.sql` to create the `kos_email_triage` Postgres
   role. This was NOT created in this plan because:
   - Migration 0015 already creates `kos_agent_writer` with grants on
     email_drafts (read), agent_runs, etc. — adopting that role would
     also work.
   - Plan asks for a SEPARATE role (`kos_email_triage`) so its grants
     can be tightened independently from the writer used by
     dossier-loader / morning-brief / etc. The CDK helper hard-codes
     `RDS_IAM_USER='kos_email_triage'` so the role has a specific name
     to be created out-of-band before deploy.
   - **Action item for ops**: create migration `0017_email_triage_role.sql`
     with `CREATE USER kos_email_triage LOGIN; GRANT rds_iam TO …;
     GRANT SELECT, INSERT, UPDATE ON email_drafts TO …;
     GRANT SELECT, INSERT ON agent_dead_letter TO …;
     GRANT SELECT ON entity_index, kevin_context, mention_events TO …;`
     before deploying this Lambda. **Documented in the plan's
     `<action>` block; punted to operator runbook.**

## Threat-model coverage (Plan 04-04 §threat_model)

| Threat | Mitigation in code |
|--------|--------------------|
| T-04-TRIAGE-01 (prompt injection) | `<email_content>`/`<email_headers>` wrap + `escapeEmailContent` + system-prompt rules + tool_use schema enforcement + Zod fallback. Adversarial-fixture handler test asserts the fixture is classified non-urgent and no draft_ready emits. |
| T-04-TRIAGE-02 (privilege drift to SES) | CDK test 5 grep — ZERO `ses:*` actions appear in any IAM policy attached to email-triage. Will fail loudly on drift. |
| T-04-TRIAGE-03 (Bedrock throttle DoS) | `withTimeoutAndRetry` 10s/2 retries + dead-letter row + inbox.dead_letter event. |
| T-04-TRIAGE-04 (no audit trail) | email_drafts row stamped with classification + reason + triaged_at + draft_id; `tagTraceWithCaptureId(captureId)` on every invocation propagates to Langfuse session. |
| T-04-TRIAGE-06 (forged event) | Zod-validated detail; EventBridge requires IAM PutEvents (no public ingress). |

## Known follow-ups not addressed in this plan
- 0017_email_triage_role.sql (migration; documented above).
- Future migration to add `email_drafts.body_text` so scan_emails_now can re-classify with full body. Currently re-runs use subject+headers only.
- Phase 6 `@kos/context-loader.loadContext` schema returns `kevin_context` as a
  structured object; this plan renders it back to markdown. When all 4
  consumer Lambdas migrate to the structured shape, drop `renderKevinContextMarkdown`.
- entity_index.email column — needed for `resolveEntitiesByEmail` to actually
  return matches. Currently degrades to [] silently (with a console.warn).

## Files NOT modified (gating reasons)
- `packages/db/drizzle/0017_*.sql` — migration left to operator runbook (see above).
- `services/email-triage/package.json` — already had every dependency required
  by the new modules (@anthropic-ai/bedrock-sdk, pg, @kos/contracts, @kos/context-loader, @kos/test-fixtures, @aws-sdk/rds-signer, etc.).
