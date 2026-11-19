// Browser E2E: the user's own video file (no YouTube link) + its transcript → best clip candidates → canvas with the
// file attached → export with real footage + audio. And: attached footage survives a reload and reopening the saved
// project (kept in the browser's IndexedDB; video files never reach the server). The source video is made with ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
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
const transcript = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/talk.transcript.txt'), 'utf8');
const screenshotDir = process.env.E2E_SCREENSHOT_DIR;

let srv: TestServer;
let tmp: string;
let sourceFile: string;
const uploadedBodies: number[] = [];
before(async () => {
  if (skip) return;
  srv = await startTestServer({
    NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}),
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-local-'));
  sourceFile = path.join(tmp, 'my-talk.mp4');
  // 135 s landscape source with a continuous 440 Hz tone standing in for speech.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=135', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=135',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile]);
});
after(async () => {
  await srv?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function openStudio(browser: any) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  // The video must never be sent to the server: record every request body size.
  page.on('request', (r: any) => {
    const body = r.postDataBuffer?.();
    if (body) uploadedBodies.push(body.length);
  });
  await page.goto(srv.baseUrl);
  await page.getByRole('button', { name: /Get Started Free/ }).first().click();
  await page.getByRole('button', { name: /Guest/ }).click();
  return { page, pageErrors };
}

async function exportAndProbe(page: any, name: string) {
  const dl = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
  const download = await dl;
  const out = path.join(tmp, `${name}.${download.suggestedFilename().split('.').pop()}`);
  await download.saveAs(out);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  const log = spawnSync('ffmpeg', ['-nostdin', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const mean = Number(/mean_volume: (-?[0-9.]+)/.exec(log)?.[1]);
  return { dur, mean };
}

test('E2E: "Your Video to Clips" — local file + pasted transcript → best clip → canvas with the file → export with real audio', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, pageErrors } = await openStudio(browser);
    await page.getByRole('heading', { name: 'Your Video to Clips' }).click();
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'source-page-your-video.png'), fullPage: true });

    // Without a transcript the server explains how to get one (no invented clips).
    await page.getByLabel('Your video file').setInputFiles(sourceFile);
    await page.getByText('my-talk.mp4').waitFor();
    await page.getByText(/2:15/).waitFor(); // duration read locally
    await page.getByRole('button', { name: /Find Clips in My Video/ }).click();
    await page.getByRole('alert').getByText(/YouTube Studio/).waitFor({ timeout: 30000 });

    await page.getByPlaceholder(/timed transcript or subtitles/).fill(transcript);
    await page.getByRole('button', { name: /Find Clips in My Video/ }).click();
    await page.getByText(/Clip Candidates/).first().waitFor({ timeout: 60000 });

    const cards = page.locator('[data-clip-candidate]');
    assert.equal(await cards.count(), 3);
    assert.match(await cards.first().innerText(), /Why does your to-do list never actually get done\?/);
    await cards.first().click();
    await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();

    // The file is already attached (offset 0), framing options are there, no YouTube-specific UI.
    await page.getByText('my-talk.mp4').waitFor();
    await page.getByText(/footage and original audio/).waitFor();
    await page.getByRole('button', { name: 'Letterbox Fit' }).click();
    await page.getByRole('button', { name: 'Vertical Fill' }).click();
    assert.equal(await page.locator('iframe[title="YouTube Source"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /footage from YouTube/ }).count(), 0);
    assert.equal(await page.locator('img[src*="ytimg.com"]').count(), 0);

    const { dur, mean } = await exportAndProbe(page, 'local');
    assert.ok(Math.abs(dur - 28.7) < 2, `clip duration ${dur}s, expected ~28.7s (29.86s → 58.56s of the source)`);
    assert.ok(mean > -35, `source audio must be in the export (mean ${mean} dB)`);
    assert.ok(Math.max(...uploadedBodies) < 1024 * 1024, `no request may carry the video (largest body ${Math.max(...uploadedBodies)} B)`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('E2E: attached footage survives a reload and reopening the saved project; removing it forgets it', { skip, timeout: 300000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page, pageErrors } = await openStudio(browser);
    await page.getByRole('heading', { name: 'YouTube Video to Clips' }).click();
    await page.getByPlaceholder(/Paste YouTube link/).fill('https://www.youtube.com/watch?v=arj7oStGLkU');
    await page.getByRole('button', { name: 'Add custom CC' }).click();
    await page.getByPlaceholder(/Paste transcript/).fill(transcript);
    await page.getByRole('button', { name: /^Analyze$/ }).click();
    await page.getByText(/Clip Candidates/).first().waitFor({ timeout: 60000 });
    await page.locator('[data-clip-candidate]').first().click();
    await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();

    await page.getByLabel('Source video file').setInputFiles(sourceFile);
    await page.getByText('my-talk.mp4').waitFor();

    // Switching studio steps keeps the file (it is held above the player).
    await page.getByRole('button', { name: /Back to Strategies/ }).click();
    await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();
    await page.getByText('my-talk.mp4').waitFor();

    // Save (the unsaved draft's footage moves to the project), then reload.
    await page.getByRole('button', { name: 'Save project' }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    await page.reload();
    await page.getByText(/restored from this browser/).waitFor({ timeout: 20000 });
    await page.getByText('my-talk.mp4').waitFor();
    if (screenshotDir) await page.locator('aside').first().screenshot({ path: path.join(screenshotDir, 'restored-footage.png') });

    const restored = await exportAndProbe(page, 'restored');
    assert.ok(Math.abs(restored.dur - 28.7) < 2, `clip duration ${restored.dur}s`);
    assert.ok(restored.mean > -35, `restored footage audio must be in the export (mean ${restored.mean} dB)`);

    // Reopen through "My projects" after the app has started on something else (nothing left in memory).
    await page.evaluate(() => {
      localStorage.removeItem('forge_active_project');
      localStorage.removeItem('forge_studio_step');
    });
    await page.reload();
    await page.getByRole('button', { name: 'My projects' }).click();
    await page.locator('div.cursor-pointer', { hasText: /Why does your to-do list/ }).first().click();
    await page.getByText(/restored from this browser/).waitFor({ timeout: 20000 });

    // Removing the file deletes it from the browser too.
    await page.getByRole('button', { name: 'Remove source video file' }).click();
    await page.getByLabel('Source video file').waitFor({ state: 'attached' });
    await page.reload();
    await page.getByRole('button', { name: 'My projects' }).click();
    await page.locator('div.cursor-pointer', { hasText: /Why does your to-do list/ }).first().click();
    await page.getByLabel('Source video file').waitFor({ state: 'attached', timeout: 20000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.getByText(/restored from this browser/).count(), 0);
    const stored = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const r = indexedDB.open('forge-footage');
          r.onsuccess = () => {
            const c = r.result.transaction('meta').objectStore('meta').count();
            c.onsuccess = () => resolve(c.result);
          };
        }),
    );
    assert.equal(stored, 0);
    assert.ok(Math.max(...uploadedBodies) < 1024 * 1024, 'no request may carry the video');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
