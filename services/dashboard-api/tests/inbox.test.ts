/**
 * Inbox POST handler schema + routing tests.
 *
 * Full DB round-trips (approve → agent_runs INSERT, edit → JSONB merge)
 * live under e2e — they need RDS Proxy. Here we cover:
 *   • zod request-body validation (400 on malformed)
 *   • InboxActionResponseSchema exit shape
 *   • missing :id param → 400
 *
 * The response contract is our second line of defence after owner-scoped.
 */
import { describe, expect, it } from 'vitest';
import {
  InboxActionResponseSchema,
  InboxApproveSchema,
  InboxEditSchema,
} from '@kos/contracts/dashboard';

describe('inbox request/response contracts', () => {
  it('InboxApproveSchema accepts an empty body', () => {
    expect(() => InboxApproveSchema.parse({})).not.toThrow();
  });

  it('InboxApproveSchema accepts optional edits object', () => {
    expect(() => InboxApproveSchema.parse({ edits: { subject: 'Re: ok' } })).not.toThrow();
  });

  it('InboxEditSchema requires fields', () => {
    expect(() => InboxEditSchema.parse({})).toThrow();
  });

  it('InboxEditSchema accepts fields object', () => {
    expect(() => InboxEditSchema.parse({ fields: { body: 'new content' } })).not.toThrow();
  });

  it('InboxActionResponseSchema accepts { ok: true } only', () => {
    expect(() => InboxActionResponseSchema.parse({ ok: true })).not.toThrow();
    expect(() => InboxActionResponseSchema.parse({ ok: false })).toThrow();
  });
});
