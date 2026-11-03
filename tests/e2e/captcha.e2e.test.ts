// Track A (R-03, A8): the browser obtains a Turnstile token before the first guest mint and the server verifies it.
// Cloudflare is NOT contacted: the widget script is intercepted with a fake `window.turnstile` that records how it
// was called and hands back a token, and siteverify is the local stub. This proves our client and server
// integration; the real Cloudflare widget is exercised only once the owner has created a widget (Track E).
// Requires Playwright + Chromium and the production build (npm run build). Run with: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, TEST_BACKEND, type TestServer } from '../helpers/server.ts';
import { startTurnstileStub } from '../helpers/turnstileStub.ts';

const require = createRequire(import.meta.url);
let chromium: any = null;
try {
  chromium = require('playwright').chromium;
} catch {
  chromium = null;
}
const hasDist = fs.existsSync(path.resolve(import.meta.dirname, '../../dist/index.html'));
const skip = !chromium ? 'playwright not installed' : !hasDist ? 'dist/ missing — run npm run build' : false;

const SECRET = `e2e-secret-${crypto.randomBytes(8).toString('hex')}`;
const SITE_KEY = '1x-e2e-site-key';
let srv: TestServer;
let stub: Awaited<ReturnType<typeof startTurnstileStub>>;
before(async () => {
  if (skip) return;
  stub = await startTurnstileStub({ secret: SECRET, hostname: '127.0.0.1' });
  srv = await startTestServer({
    SERVE_DIST: '1', // test mode serving the production build (never available in production mode)
    CAPTCHA_REQUIRED: 'true',
    TURNSTILE_SECRET: SECRET,
    TURNSTILE_SITE_KEY: SITE_KEY,
    TURNSTILE_HOSTNAMES: '127.0.0.1',
    TURNSTILE_VERIFY_URL: stub.url,
    TRUST_PROXY: 'none',
    ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}),
  });
});
after(async () => {
  await srv?.stop();
  await stub?.close();
});

const FAKE_TURNSTILE = `
  window.__turnstileCalls = [];
  window.turnstile = {
    render(el, opts) {
      window.__turnstileCalls.push({ sitekey: opts.sitekey, action: opts.action, inDom: document.body.contains(el) });
      setTimeout(() => opts.callback('ok-e2e-' + Math.random().toString(16).slice(2)), 50);
      return 'w1';
    },
    remove() {}, reset() {}, execute() {},
  };
  (window.__onTurnstileLoad || function(){})();
`;

test('E2E: guest onboarding solves Turnstile (site key from /api/config, action guest_mint) and the server verifies it', { skip, timeout: 120000 }, async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  const scriptRequests: string[] = [];
  await page.route('https://challenges.cloudflare.com/**', async (route: any) => {
    scriptRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TURNSTILE });
  });
  try {
    await page.goto(srv.baseUrl);
    await page.getByRole('button', { name: /Get Started Free/ }).first().click();
    await page.getByRole('button', { name: /Guest/ }).click();
    await page.getByRole('heading', { name: 'Idea Prompt to Short' }).waitFor({ timeout: 30000 });
    const token = await page.evaluate(() => localStorage.getItem('forge_guest_token'));
    assert.ok(token && token.includes('guest.'), 'a guest session was minted');
    assert.ok(scriptRequests.some((u) => u.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')), `widget script requested: ${scriptRequests.join(' ')}`);
    const calls = await page.evaluate(() => (window as any).__turnstileCalls);
    assert.deepEqual(calls.map((c: any) => [c.sitekey, c.action]), [[SITE_KEY, 'guest_mint']], JSON.stringify(calls));
    assert.ok(stub.calls.some((c) => c.response.startsWith('ok-e2e-') && c.secret === SECRET), 'the server verified the browser token');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
