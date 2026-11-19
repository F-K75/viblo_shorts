// FS-013: the production Content-Security-Policy must not block any legitimate feature. Runs the production build
// in production mode and records every CSP violation (DOM event + Chromium console) during:
//   1. sign-in page → "Continue with Google" (firebase/auth loads gapi from apis.google.com) → guest onboarding
//   2. YouTube link → clip candidates → editor with the YouTube embed + thumbnails → export (MediaRecorder, blob:)
// External hosts are network-blocked in CI sandboxes: loads may fail with network errors, but a CSP block is reported
// before any network access, so a missing allow-list entry is still detected. A self-check proves the watcher works.
// Requires Playwright + Chromium and the production build (npm run build). Run with: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startTestServer, TEST_BACKEND, type TestServer } from '../helpers/server.ts';
import { watchCspViolations, formatViolations } from '../helpers/cspWatch.ts';

const require = createRequire(import.meta.url);
let chromium: any = null;
try {
  chromium = require('playwright').chromium;
} catch {
  chromium = null;
}
const hasDist = fs.existsSync(path.resolve(import.meta.dirname, '../../dist/index.html'));
const skip = !chromium ? 'playwright not installed' : !hasDist ? 'dist/ missing — run npm run build' : false;

let srv: TestServer;
before(async () => {
  if (skip) return;
  srv = await startTestServer({ NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}) });
});
after(async () => srv?.stop());

test('E2E CSP: Google sign-in attempt, guest onboarding, YouTube clip → editor → export with zero CSP violations', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const violations = await watchCspViolations(page, srv.baseUrl);
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  const externalRequests = new Set<string>();
  page.on('request', (r: any) => {
    const u = new URL(r.url());
    if (u.protocol === 'https:') externalRequests.add(u.host);
  });
  try {
    const res = await page.goto(srv.baseUrl);
    assert.ok(res.headers()['content-security-policy'], 'the document is served with an enforced CSP');

    // Self-check: the watcher sees a real violation of our policy, then the list is reset.
    await page.evaluate(() => fetch('https://csp-selfcheck.invalid/x').catch(() => undefined));
    await page.waitForTimeout(300);
    assert.ok(violations.some((v) => v.text.includes('csp-selfcheck.invalid')), `watcher must detect a blocked connect: ${formatViolations(violations)}`);
    violations.length = 0;

    // 1. Sign-in page; Google sign-in makes firebase/auth inject https://apis.google.com/js/api.js and open a popup.
    await page.getByRole('button', { name: /Get Started Free/ }).first().click();
    const popup = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await page.getByRole('button', { name: /Continue with Google/ }).click();
    const p = await popup;
    await page.waitForTimeout(1500);
    await p?.close().catch(() => undefined);
    assert.ok(externalRequests.has('apis.google.com'), `firebase/auth requested the gapi loader (hosts: ${[...externalRequests].join(' ')})`);
    // Back to the sign-in page if Firebase reported an error, then continue as guest.
    await page.getByRole('button', { name: /Guest/ }).click();
    await page.getByRole('heading', { name: 'Idea Prompt to Short' }).waitFor({ timeout: 30000 });

    // 2. YouTube clip flow.
    await page.locator('input').first().fill('https://www.youtube.com/watch?v=UF8uR6Z6KLc');
    await page.getByRole('button', { name: /^Analyze$/ }).click();
    await page.getByText(/Clip Strategies & Clip Trimmer/).first().waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: /Canvas & Timeline/ }).first().click();
    await page.locator('iframe[src^="https://www.youtube.com/embed/"]').first().waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);

    // Export: canvas + MediaRecorder + blob: download.
    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    const download = await dl;
    assert.ok(download.suggestedFilename());

    assert.ok(externalRequests.has('i.ytimg.com'), 'YouTube thumbnails were requested');
    assert.equal(violations.length, 0, `CSP violations:\n${formatViolations(violations)}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
