/**
 * email-sender ses.ts unit tests (Plan 04-05 Task 1).
 *
 * 4 tests cover buildRawMessage's RFC 5322 shape:
 *   1. Required headers (From / To / Subject / Date / Message-ID / MIME-Version)
 *      all present + Content-Type defaults to text/plain.
 *   2. inReplyTo + references propagate to In-Reply-To / References headers
 *      when supplied.
 *   3. Plain-text body → single text/plain part (no boundary).
 *   4. bodyText + bodyHtml → multipart/alternative with two parts.
 *
 * Tests assert structural shape (header presence + CRLF separation +
 * body parts) — exact bytes drift on Date / Message-ID / boundary so
 * we use regex / .includes for everything time-varying.
 */
import { describe, expect, it } from 'vitest';
import { buildRawMessage } from '../src/ses.js';

describe('buildRawMessage', () => {
  it('Test 1: produces RFC 5322 headers with text/plain default Content-Type', () => {
    const raw = buildRawMessage({
      from: 'kevin@tale-forge.app',
      to: ['damien@example.com'],
      subject: 'Hej',
      bodyText: 'Hallå Damien',
    });
    // CRLF header / body separator.
    expect(raw).toContain('\r\n\r\n');
    // Required headers.
    expect(raw).toMatch(/^From: kevin@tale-forge\.app\r\n/);
    expect(raw).toContain('To: damien@example.com');
    expect(raw).toContain('Subject: Hej');
    expect(raw).toMatch(/Date: [A-Z][a-z]{2}, /); // RFC 2822 dayname
    expect(raw).toMatch(/Message-ID: <\d+\.[a-z0-9]+@kos\.tale-forge\.app>/);
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    // No multipart boundary in plain text path.
    expect(raw).not.toMatch(/Content-Type: multipart\/alternative/);
    // Body present after blank line.
    expect(raw.split('\r\n\r\n')[1]).toBe('Hallå Damien');
  });

  it('Test 2: inReplyTo + references included when supplied', () => {
    const raw = buildRawMessage({
      from: 'kevin@tale-forge.app',
      to: ['damien@example.com'],
      cc: ['ops@example.com'],
      subject: 'Re: Hej',
      bodyText: 'Replying',
      inReplyTo: '<orig.123@sender.com>',
      references: ['<orig.123@sender.com>', '<orig.122@sender.com>'],
    });
    expect(raw).toContain('In-Reply-To: <orig.123@sender.com>');
    expect(raw).toContain('References: <orig.123@sender.com> <orig.122@sender.com>');
    expect(raw).toContain('Cc: ops@example.com');
  });

  it('Test 3: bodyText only → single text/plain part, no boundary', () => {
    const raw = buildRawMessage({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 's',
      bodyText: 'plain only',
    });
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).not.toContain('multipart/alternative');
    expect(raw).not.toContain('--KOS-BOUNDARY-');
  });

  it('Test 4: bodyText + bodyHtml → multipart/alternative with both parts', () => {
    const raw = buildRawMessage({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 's',
      bodyText: 'plain side',
      bodyHtml: '<p>html side</p>',
    });
    // Top-level Content-Type signals multipart.
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="KOS-BOUNDARY-[a-z0-9]+"/);
    // Both parts present.
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('plain side');
    expect(raw).toContain('<p>html side</p>');
    // Closing boundary marker present.
    expect(raw).toMatch(/--KOS-BOUNDARY-[a-z0-9]+--/);
  });
});
