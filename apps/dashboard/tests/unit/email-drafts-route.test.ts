/**
 * apps/dashboard /api/email-drafts/[id]/{approve,edit,skip} route tests.
 *
 * Each Route Handler forwards to services/dashboard-api via the
 * Bearer-auth `callApi` helper. Tests mock callApi and assert:
 *   - invalid uuid path → 400
 *   - happy path → upstream call args + response passthrough
 *   - upstream error → 502
 *   - edit body validation (subject + body bounds)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const callApiMock = vi.fn();

vi.mock('@/lib/dashboard-api', () => ({
  callApi: callApiMock,
}));

const VALID_UUID = '7a6b5c4d-3e2f-4a09-8b7c-6d5e4f3a2b1c';
const AUTH_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  callApiMock.mockReset();
  vi.resetModules();
});

describe('POST /api/email-drafts/:id/approve', () => {
  it('returns 400 for invalid uuid', async () => {
    const { POST } = await import('@/app/api/email-drafts/[id]/approve/route');
    const req = new Request('http://localhost/api/email-drafts/bad/approve', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'bad' }) });
    expect(res.status).toBe(400);
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('happy path forwards to upstream + returns body', async () => {
    callApiMock.mockResolvedValueOnce({ ok: true, authorization_id: AUTH_ID });
    const { POST } = await import('@/app/api/email-drafts/[id]/approve/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/approve`,
      { method: 'POST' },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; authorization_id: string };
    expect(body.ok).toBe(true);
    expect(body.authorization_id).toBe(AUTH_ID);
    const [path, init] = callApiMock.mock.calls[0]!;
    expect(path).toBe(`/email-drafts/${VALID_UUID}/approve`);
    expect((init as { method: string }).method).toBe('POST');
  });

  it('upstream rejection → 502', async () => {
    callApiMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/email-drafts/[id]/approve/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/approve`,
      { method: 'POST' },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/email-drafts/:id/edit', () => {
  it('returns 400 on missing body fields', async () => {
    const { POST } = await import('@/app/api/email-drafts/[id]/edit/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/edit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '' }),
      },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(400);
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('rejects body > 10_000 chars', async () => {
    const { POST } = await import('@/app/api/email-drafts/[id]/edit/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/edit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: 'a'.repeat(10_001),
          subject: 'ok',
        }),
      },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(400);
  });

  it('happy path forwards parsed body', async () => {
    callApiMock.mockResolvedValueOnce({ ok: true, status: 'edited' });
    const { POST } = await import('@/app/api/email-drafts/[id]/edit/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/edit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'edited', subject: 'Re: edited' }),
      },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    const [path, init] = callApiMock.mock.calls[0]!;
    expect(path).toBe(`/email-drafts/${VALID_UUID}/edit`);
    const sentBody = JSON.parse((init as { body: string }).body) as {
      body: string;
      subject: string;
    };
    expect(sentBody.body).toBe('edited');
    expect(sentBody.subject).toBe('Re: edited');
  });
});

describe('POST /api/email-drafts/:id/skip', () => {
  it('returns 400 for invalid uuid', async () => {
    const { POST } = await import('@/app/api/email-drafts/[id]/skip/route');
    const req = new Request('http://localhost/api/email-drafts/bad/skip', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'bad' }) });
    expect(res.status).toBe(400);
  });

  it('happy path forwards', async () => {
    callApiMock.mockResolvedValueOnce({ ok: true, status: 'skipped' });
    const { POST } = await import('@/app/api/email-drafts/[id]/skip/route');
    const req = new Request(
      `http://localhost/api/email-drafts/${VALID_UUID}/skip`,
      { method: 'POST' },
    );
    const res = await POST(req, { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe('skipped');
  });
});
