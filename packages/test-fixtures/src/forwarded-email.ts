/**
 * Phase 4 Plan 04-00 Task 5 — forwarded-email MIME fixture.
 *
 * Realistic multipart/alternative MIME representing Kevin forwarding an
 * email from his personal inbox to forward@kos.tale-forge.app. Used by the
 * ses-inbound Lambda's mailparser unit tests + by Gate 3's end-to-end
 * forward path.
 *
 * `FORWARDED_EMAIL_HEADERS_ONLY` is the raw header block alone — useful
 * for header-parser unit tests that don't want to slurp the full MIME
 * payload.
 */

export const FORWARDED_EMAIL_HEADERS_ONLY = [
  'From: Kevin El-zarka <kevin@elzarka.se>',
  'To: forward@kos.tale-forge.app',
  'Cc: assistant@example.com',
  'Subject: Fwd: Almi Invest avtal v2',
  'Date: Fri, 25 Apr 2026 09:14:22 +0200',
  'Message-ID: <forward-almi-v2@elzarka.se>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="kos-fixture-boundary-001"',
].join('\r\n');

const ORIGINAL_PLAIN = [
  '---------- Forwarded message ---------',
  'From: Anders Almi <anders@almi.example>',
  'Date: Fri, 25 Apr 2026 08:50:11 +0200',
  'Subject: Almi Invest avtal v2',
  'To: Kevin El-zarka <kevin@elzarka.se>',
  '',
  'Hej Kevin,',
  '',
  'Bifogar avtalsutkast v2 (markup mot v1 finns i sidpanelen).',
  'Är ni okej med ändringarna i §4 (sekretess)? Vi bokar en kort',
  'uppföljning på måndag om det funkar.',
  '',
  '/Anders',
].join('\r\n');

const ORIGINAL_HTML = [
  '<!doctype html><html><body>',
  '<p>---------- Forwarded message ---------<br/>',
  'From: <b>Anders Almi</b> &lt;anders@almi.example&gt;<br/>',
  'Date: Fri, 25 Apr 2026 08:50:11 +0200<br/>',
  'Subject: Almi Invest avtal v2<br/>',
  'To: Kevin El-zarka &lt;kevin@elzarka.se&gt;</p>',
  '<p>Hej Kevin,</p>',
  '<p>Bifogar avtalsutkast v2 (markup mot v1 finns i sidpanelen).',
  'Är ni okej med ändringarna i §4 (sekretess)? Vi bokar en kort',
  'uppföljning på måndag om det funkar.</p>',
  '<p>/Anders</p>',
  '</body></html>',
].join('\r\n');

export const FORWARDED_EMAIL_MIME = [
  FORWARDED_EMAIL_HEADERS_ONLY,
  '',
  '--kos-fixture-boundary-001',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  ORIGINAL_PLAIN,
  '',
  '--kos-fixture-boundary-001',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  ORIGINAL_HTML,
  '',
  '--kos-fixture-boundary-001--',
  '',
].join('\r\n');
