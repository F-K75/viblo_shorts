// FS-013: Content-Security-Policy builder (pure) and the headers the real server sends.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildContentSecurityPolicy, cspHeaderName, parseCspEnv, PERMISSIONS_POLICY } from '../server/lib/csp.ts';
import { startTestServer, TEST_BACKEND, type TestServer } from './helpers/server.ts';

const directive = (csp: string, name: string): string[] | undefined => {
  const d = csp.split(';').map((s) => s.trim().split(/\s+/)).find((parts) => parts[0] === name);
  return d?.slice(1);
};

describe('buildContentSecurityPolicy', () => {
  const prod = buildContentSecurityPolicy({ mode: 'production', firebaseAuthDomain: 'demo-app.firebaseapp.com' });

  test('production script policy: no unsafe-eval, no unsafe-inline, only the script hosts the client loads', () => {
    assert.deepEqual(directive(prod, 'script-src'), ["'self'", 'https://challenges.cloudflare.com', 'https://apis.google.com']);
    assert.doesNotMatch(prod, /unsafe-eval/);
    assert.equal(directive(prod, 'default-src')?.join(' '), "'self'");
  });

  test('lockdown directives', () => {
    assert.deepEqual(directive(prod, 'object-src'), ["'none'"]);
    assert.deepEqual(directive(prod, 'base-uri'), ["'self'"]);
    assert.deepEqual(directive(prod, 'form-action'), ["'self'"]);
    assert.deepEqual(directive(prod, 'frame-ancestors'), ["'self'"]);
    assert.equal(directive(prod, 'upgrade-insecure-requests'), undefined, 'only for HTTPS requests');
    assert.equal(directive(prod, 'report-uri'), undefined);
  });

  test('feature hosts are allowed in the right directive', () => {
    const has = (d: string, src: string) => assert.ok(directive(prod, d)?.includes(src), `${d} must include ${src}: ${prod}`);
    has('frame-src', 'https://www.youtube.com');
    has('frame-src', 'https://challenges.cloudflare.com');
    has('frame-src', 'https://demo-app.firebaseapp.com');
    has('img-src', 'https://i.ytimg.com');
    has('img-src', 'data:');
    has('img-src', 'https://images.unsplash.com');
    has('img-src', 'https://images.pexels.com');
    has('img-src', 'https://api.dicebear.com');
    has('img-src', 'https://lh3.googleusercontent.com');
    has('media-src', 'blob:');
    has('media-src', 'https://assets.mixkit.co');
    has('media-src', 'https://videos.pexels.com');
    has('connect-src', 'https://identitytoolkit.googleapis.com');
    has('connect-src', 'https://securetoken.googleapis.com');
    has('connect-src', 'https://www.googleapis.com');
    has('style-src', 'https://fonts.googleapis.com');
    has('font-src', 'https://fonts.gstatic.com');
    // No broad wildcards or websocket schemes in production.
    assert.doesNotMatch(prod, /\*\.|\bws:|\bwss:|https:(?=\s|;|$)/);
  });

  test('development relaxes only what the Vite dev server and preview iframe need', () => {
    const dev = buildContentSecurityPolicy({ mode: 'development' });
    assert.ok(directive(dev, 'script-src')?.includes("'unsafe-inline'"));
    assert.ok(directive(dev, 'connect-src')?.includes('ws:'));
    assert.deepEqual(directive(dev, 'frame-ancestors'), ['*']);
    assert.doesNotMatch(dev, /unsafe-eval/);
  });

  test('upgrade-insecure-requests and report-uri; upgrade is dropped from report-only policies', () => {
    const https = buildContentSecurityPolicy({ mode: 'production', upgradeInsecureRequests: true, reportUri: '/csp-report' });
    assert.deepEqual(directive(https, 'upgrade-insecure-requests'), []);
    assert.deepEqual(directive(https, 'report-uri'), ['/csp-report']);
    const ro = buildContentSecurityPolicy({ mode: 'production', upgradeInsecureRequests: true, reportOnly: true });
    assert.equal(directive(ro, 'upgrade-insecure-requests'), undefined);
    assert.equal(cspHeaderName(true), 'Content-Security-Policy-Report-Only');
    assert.equal(cspHeaderName(false), 'Content-Security-Policy');
  });

  test('extra sources are appended once to their directive', () => {
    const csp = buildContentSecurityPolicy({ mode: 'production', extra: { 'connect-src': ['https://api.example.com', "'self'"], 'img-src': ['https://cdn.example.com'] } });
    assert.deepEqual(directive(csp, 'connect-src')?.slice(-1), ['https://api.example.com']);
    assert.equal(directive(csp, 'connect-src')?.filter((s) => s === "'self'").length, 1);
    assert.ok(directive(csp, 'img-src')?.includes('https://cdn.example.com'));
  });
});

describe('parseCspEnv', () => {
  test('defaults', () => {
    assert.deepEqual(parseCspEnv({}), { ok: true, extra: {}, reportOnly: false, reportUri: undefined });
  });
  test('extra hosts, report-only and report-uri', () => {
    const r = parseCspEnv({
      CSP_EXTRA_CONNECT_SRC: 'https://api.example.com, wss://rt.example.com',
      CSP_EXTRA_SCRIPT_SRC: 'https://www.google.com/recaptcha/',
      CSP_EXTRA_FRAME_SRC: 'https://*.example.com:8443',
      CSP_REPORT_ONLY: 'true',
      CSP_REPORT_URI: 'https://csp.example.com/report',
    });
    assert.ok(r.ok);
    assert.deepEqual(r.extra, {
      'connect-src': ['https://api.example.com', 'wss://rt.example.com'],
      'script-src': ['https://www.google.com/recaptcha/'],
      'frame-src': ['https://*.example.com:8443'],
    });
    assert.equal(r.reportOnly, true);
    assert.equal(r.reportUri, 'https://csp.example.com/report');
  });
  test('refuses keywords, plain http, bare wildcards and injection', () => {
    for (const bad of ["'unsafe-eval'", "'unsafe-inline'", 'http://example.com', '*', 'https:', 'https://a.com;script-src *', "'nonce-abc'"]) {
      const r = parseCspEnv({ CSP_EXTRA_SCRIPT_SRC: bad });
      assert.equal(r.ok, false, bad);
    }
    assert.equal(parseCspEnv({ CSP_REPORT_ONLY: 'yes' }).ok, false);
    assert.equal(parseCspEnv({ CSP_REPORT_URI: 'javascript:alert(1)' }).ok, false);
    assert.equal(parseCspEnv({ CSP_REPORT_URI: '/csp; script-src *' }).ok, false);
  });
});

describe('production server security headers', () => {
  const servers: TestServer[] = [];
  after(async () => {
    for (const s of servers) await s.stop();
  });
  const prodEnv = { NODE_ENV: 'production', TRUST_PROXY: '1', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}) };
  const hasDist = fs.existsSync(path.resolve(import.meta.dirname, '../dist/index.html'));

  test('/ carries the strict policy and the other headers; /api/health is unchanged', async () => {
    const s = await startTestServer(prodEnv);
    servers.push(s);
    const page = await fetch(`${s.baseUrl}/`);
    const csp = page.headers.get('content-security-policy');
    assert.ok(csp, 'CSP on the HTML document');
    assert.deepEqual(directive(csp, 'script-src'), ["'self'", 'https://challenges.cloudflare.com', 'https://apis.google.com']);
    assert.ok(directive(csp, 'frame-src')?.includes('https://forge-506009.firebaseapp.com'), 'authDomain from firebase-applet-config.json');
    assert.equal(directive(csp, 'upgrade-insecure-requests'), undefined, 'plain HTTP request');
    assert.equal(page.headers.get('content-security-policy-report-only'), null);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.equal(page.headers.get('permissions-policy'), PERMISSIONS_POLICY);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('strict-transport-security') || '', /max-age=31536000/);
    if (hasDist) {
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<div id="root">/);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'the production index.html has no inline scripts');
    }

    const health = await fetch(`${s.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type') || '', /application\/json/);
    assert.equal(await health.text(), '{"status":"ok"}');
    assert.equal(health.headers.get('content-security-policy'), csp);

    // Behind the trusted proxy hop, an HTTPS request gets upgrade-insecure-requests.
    const secure = await fetch(`${s.baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.deepEqual(directive(secure.headers.get('content-security-policy') || '', 'upgrade-insecure-requests'), []);
  });

  test('report-only mode, report-uri and extra hosts from the environment; invalid values stop startup', async () => {
    const s = await startTestServer({ ...prodEnv, CSP_REPORT_ONLY: 'true', CSP_REPORT_URI: '/csp-report', CSP_EXTRA_IMG_SRC: 'https://cdn.example.com' });
    servers.push(s);
    const r = await fetch(`${s.baseUrl}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.headers.get('content-security-policy'), null);
    const ro = r.headers.get('content-security-policy-report-only') || '';
    assert.deepEqual(directive(ro, 'report-uri'), ['/csp-report']);
    assert.ok(directive(ro, 'img-src')?.includes('https://cdn.example.com'));
    assert.equal(directive(ro, 'upgrade-insecure-requests'), undefined);
    await assert.rejects(startTestServer({ ...prodEnv, CSP_EXTRA_SCRIPT_SRC: "'unsafe-eval'" }), (e: any) => /CSP_EXTRA_SCRIPT_SRC/.test(e.message));
  });
});
