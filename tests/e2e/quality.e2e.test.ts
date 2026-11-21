// Browser E2E of the post-export quality gate: record → upload → conform → evaluate → (re-record) → deliver.
// Test 2 reproduces the reference reel's defect (a browser encoder that delivers 512x910 for a 1080x1920 canvas) by
// substituting the uploaded recording, and checks that the app rejects it instead of shipping it as "1080p".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
let tmp: string;
before(async () => {
  if (skip) return;
  srv = await startTestServer({ NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}) });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-q-'));
});
after(async () => {
  await srv?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function ideaShort(browser: any) {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  const csp = await watchCspViolations(page, srv.baseUrl);
  await page.goto(srv.baseUrl);
  await page.getByRole('button', { name: /Get Started Free/ }).first().click();
  await page.getByRole('button', { name: /Guest/ }).click();
  await page.getByRole('heading', { name: 'Idea Prompt to Short' }).click();
  await page.locator('input').first().fill('5 science-backed habits to fall asleep faster');
  await page.getByRole('button', { name: /Generate Script/i }).click();
  await page.getByText(/Clip Strategies & Clip Trimmer/).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Canvas & Timeline/ }).first().click();
  return { page, pageErrors, csp };
}

test('E2E quality: an export is conformed, evaluated and delivered under its measured spec, with a report', { skip, timeout: 300000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, pageErrors, csp } = await ideaShort(browser);
    const dl = page.waitForEvent('download', { timeout: 240000 });
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    const report = page.getByTestId('quality-report');
    await report.waitFor({ timeout: 240000 });
    const status = await page.getByTestId('quality-status').innerText();
    assert.match(status, /Pass|Needs improvement|Rejected/);
    assert.match(await page.getByTestId('quality-spec').innerText(), /1080×1920 · 30 fps · H264 · yuv420p · AAC · fast start/);
    for (const label of ['Audio quality', 'Video & export quality', 'Visual quality', 'Caption quality', 'Storytelling & narrative', 'Pacing & engagement', 'Technical consistency']) {
      assert.ok((await report.innerText()).includes(label), label);
    }
    assert.match(await page.getByTestId('quality-remediation').innerText(), /Re-encoded to H\.264/);
    if (/Rejected/.test(status)) await page.getByRole('button', { name: /Download anyway/ }).click();
    const download = await dl;
    assert.match(download.suggestedFilename(), /^forge_short_1080x1920_\d+\.mp4$/);
    const out = path.join(tmp, 'ok.mp4');
    await download.saveAs(out);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', out]).toString();
    assert.match(probe, /h264,1080,1920,yuv420p/);
    assert.match(probe, /aac/);
    assert.deepEqual(pageErrors, []);
    assert.equal(csp.length, 0, formatViolations(csp));
  } finally {
    await browser.close();
  }
});

test('E2E quality (regression): an encoder-downscaled 512x910 recording is rejected, re-recorded once, never shipped as 1080p', { skip, timeout: 400000 }, async () => {
  const small = path.join(tmp, 'small.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=512x910:r=30:d=27', '-f', 'lavfi', '-i', 'sine=f=440:d=27',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', small]);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, pageErrors } = await ideaShort(browser);
    let uploads = 0;
    // Simulate the browser encoder: whatever was recorded, the file that reaches the server is 512x910.
    await page.route('**/api/quality/uploads', async (route: any) => {
      uploads++;
      await route.continue({ postData: fs.readFileSync(small), headers: { ...route.request().headers(), 'content-type': 'video/mp4' } });
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    await page.getByTestId('quality-report').waitFor({ timeout: 360000 });
    assert.match(await page.getByTestId('quality-status').innerText(), /Rejected/);
    assert.match(await page.getByTestId('quality-spec').innerText(), /512×910/);
    assert.match(await page.getByTestId('quality-spec').innerText(), /does not meet the export spec/);
    assert.match(await page.getByTestId('quality-problems').innerText(), /CRITICAL\s*Actual size is 512x910, not the requested 1080x1920/i);
    assert.match(await page.getByTestId('quality-remediation').innerText(), /Re-recorded automatically \(2 attempts\)/);
    assert.equal(uploads, 2, 'exactly one bounded re-record');
    assert.equal(downloads, 0, 'a rejected reel is not downloaded automatically');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download anyway/ }).click();
    assert.match((await dl).suggestedFilename(), /^forge_short_512x910_\d+\.mp4$/, 'named by its real size, never "1080p"');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
