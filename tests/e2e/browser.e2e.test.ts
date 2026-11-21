// Browser end-to-end test of the critical user journey against the PRODUCTION build (npm run build first).
// Guest onboarding → session persistence → prompt generation → save → projects → export (duration verified).
// Requires Playwright + Chromium. Run with: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { watchCspViolations, formatViolations } from '../helpers/cspWatch.ts';
import { startTestServer, TEST_BACKEND, type TestServer } from '../helpers/server.ts';

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
  // Track A: production now requires Turnstile unless explicitly disabled. This journey runs without CAPTCHA; the
  // CAPTCHA journey is tests/e2e/captcha.e2e.test.ts.
  srv = await startTestServer({ NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}) });
});
after(async () => srv?.stop());

test('E2E: guest onboarding → generate → save → projects → export', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const cspViolations = await watchCspViolations(page, srv.baseUrl); // FS-013: the production CSP blocks nothing legitimate
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  try {
    await page.goto(srv.baseUrl);
    await page.getByRole('button', { name: /Get Started Free/ }).first().click();
    await page.getByRole('button', { name: /Guest/ }).click();
    await page.getByRole('heading', { name: 'Idea Prompt to Short' }).waitFor();

    // Session persists across reload and is a server-issued guest token.
    const token = await page.evaluate(() => localStorage.getItem('forge_guest_token'));
    assert.ok(token && token.includes('guest.'));
    await page.reload();
    await page.getByRole('heading', { name: 'Idea Prompt to Short' }).waitFor();

    // Invalid input: free text in YouTube mode yields a clear error, not a bogus video.
    await page.locator('input').first().fill('5 productivity habits');
    await page.getByRole('button', { name: /^Analyze$/ }).click();
    await page.getByText(/Please paste a YouTube video link/).first().waitFor();

    // Prompt → script (honest fallback notice when no AI key)
    await page.getByRole('heading', { name: 'Idea Prompt to Short' }).click();
    await page.locator('input').first().fill('5 science-backed habits to fall asleep faster');
    await page.getByRole('button', { name: /Generate Script/i }).click();
    await page.getByText(/Clip Strategies & Clip Trimmer/).first().waitFor({ timeout: 30000 });
    await page.getByText(/AI is not configured on this server/).waitFor();

    // Save a new project (regression: used to 403 silently on the sample id)
    await page.getByRole('button', { name: /Canvas & Timeline/ }).first().click();
    await page.getByRole('button', { name: 'Save project' }).first().click();
    await page.getByText('Saved project').waitFor({ timeout: 10000 });

    // Projects modal shows it; Escape closes it
    await page.getByRole('button', { name: 'My projects' }).first().click();
    await page.getByText(/Hours of Sleep/).first().waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('div.fixed.inset-0.z-50').count(), 0);

    // Export: output duration must match the timeline (regression: 33s exported as 10.6s)
    const durText = (await page.innerText('body')).match(/([0-9.]+)s duration/);
    const timeline = Number(durText?.[1]);
    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    const download = await dl;
    const out = path.join(os.tmpdir(), `forge-e2e-${Date.now()}.${download.suggestedFilename().split('.').pop()}`);
    await download.saveAs(out);
    const lastPts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', out])
      .toString()
      .trim()
      .split('\n')
      .map(Number)
      .filter((n) => !isNaN(n))
      .reduce((a, b) => Math.max(a, b), 0);
    assert.ok(Math.abs(lastPts - timeline) < 1.5, `exported ${lastPts}s vs timeline ${timeline}s`);
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).toString();
    assert.match(streams, /audio/, 'export must contain an audio track');
    fs.rmSync(out, { force: true });
    assert.deepEqual(pageErrors, []);
    assert.equal(cspViolations.length, 0, `CSP violations:\n${formatViolations(cspViolations)}`);
  } finally {
    await browser.close();
  }
});
