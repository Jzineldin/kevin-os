import { describe, it, expect } from 'vitest';
import { handler } from '../src/handler.js';

describe('telegram-bot scaffold', () => {
  it('handler returns ok', async () => {
    const res = await handler({});
    expect(res).toEqual({ ok: true });
  });
});
