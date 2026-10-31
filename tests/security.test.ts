// Unit tests for the REAL production security helpers (server/lib/security.ts) — no mirrored copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeExternalUrl,
  isValidRenderId,
  parseRangeHeader,
  escapeDrawtext,
  sanitizeString,
  clampNumber,
} from '../server/lib/security.ts';

test('SSRF: blocks loopback, private, link-local, metadata, IPv6 and encoded IPs', () => {
  const unsafe = [
    'http://localhost:3000/api/secret',
    'http://127.0.0.1:8080/admin',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.1/internal-dashboard',
    'http://192.168.1.1/router',
    'http://172.16.0.5/docker-service',
    'http://100.64.0.1/cgnat',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://2130706433/',
    'http://user:pass@example.com/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_flushall',
    'javascript:alert(1)',
  ];
  for (const u of unsafe) assert.equal(isSafeExternalUrl(u), false, `must reject ${u}`);
});

test('SSRF: permits public endpoints and enforces allowlist suffixes', () => {
  assert.equal(isSafeExternalUrl('https://www.youtube.com/watch?v=UF8uR6Z6KLc'), true);
  assert.equal(isSafeExternalUrl('https://api.pexels.com/videos/search'), true);
  const allow = ['youtube.com', 'googlevideo.com'];
  assert.equal(isSafeExternalUrl('https://rr1---sn-4g5edn6r.googlevideo.com/videoplayback', allow), true);
  assert.equal(isSafeExternalUrl('https://attacker-domain.com/evil', allow), false);
  assert.equal(isSafeExternalUrl('https://youtube.com.attacker.com/x', allow), false);
});

test('Render ids: only server-generated format accepted (path traversal regression)', () => {
  assert.equal(isValidRenderId('render_' + 'a'.repeat(32)), true);
  for (const bad of ['../../leak', '..%2F..%2Fleak', 'render_123', 'render_' + 'A'.repeat(32), 'render_' + 'a'.repeat(32) + '/x', '']) {
    assert.equal(isValidRenderId(bad), false, bad);
  }
});

test('Range header: valid, suffix, open-ended and unsatisfiable ranges', () => {
  assert.equal(parseRangeHeader(undefined, 100), null);
  assert.deepEqual(parseRangeHeader('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRangeHeader('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=50-1000', 100), { start: 50, end: 99 });
  for (const bad of ['bytes=abc-', 'bytes=999-', 'bytes=5-1', 'items=0-1', 'bytes=-', 'bytes=-0']) {
    assert.equal(parseRangeHeader(bad, 100), 'unsatisfiable', bad);
  }
});

test('drawtext escaping removes quote/escape/expansion characters', () => {
  const out = escapeDrawtext("it's 100% \\ok: x';drawtext=textfile=/etc/passwd");
  for (const ch of ["'", '"', '\\', ':', '%', ';']) assert.ok(!out.includes(ch), `contains ${ch}`);
  assert.ok(escapeDrawtext('a'.repeat(500), 45).length <= 45);
});

test('sanitizeString and clampNumber', () => {
  assert.equal(sanitizeString('  hi\u0000there  ', 100), 'hithere');
  assert.equal(sanitizeString(42 as any), '');
  assert.equal(sanitizeString('abcdef', 3), 'abc');
  assert.equal(clampNumber('5', 0, 10, 1), 5);
  assert.equal(clampNumber('nope', 0, 10, 7), 7);
  assert.equal(clampNumber(1e9, 0, 60, 1), 60);
});
