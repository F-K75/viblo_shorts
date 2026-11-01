// Browser end-to-end test of the critical user journey against the PRODUCTION build (npm run build first).
// Guest onboarding → session persistence → prompt generation → save → projects → export (duration verified).
// Requires Playwright + Chromium. Run with: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { startTestServer, type TestServer } from '../helpers/server.ts';

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
  srv = await startTestServer({ NODE_ENV: 'production' });
});
after(async () => srv?.stop());

test('E2E: guest onboarding → generate → save → projects → export', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
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
  } finally {
    await browser.close();
  }
});

// Stand-in for YouTube's IFrame Player API (YouTube is unreachable in CI/sandbox). It follows the documented
// contract (YT.Player, onReady, getPlayerState, getCurrentTime) and simulates 2 s of buffering after play.
const FAKE_YT_API = `
window.YT = { Player: function (el, opts) {
  let state = -1, base = 0, startedAt = 0; const self = this;
  this.getCurrentTime = () => state === 1 ? base + (performance.now() - startedAt) / 1000 : base;
  this.getPlayerState = () => state;
  this.playVideo = () => { if (state === 1) return; state = 3; setTimeout(() => { state = 1; startedAt = performance.now(); }, 2000); };
  this.pauseVideo = () => { if (state === 1) base = self.getCurrentTime(); state = 2; };
  this.seekTo = (s) => { base = s; if (state === 1) startedAt = performance.now(); };
  this.mute = () => {}; this.unMute = () => {}; this.setVolume = () => {}; this.destroy = () => {};
  setTimeout(() => opts.events.onReady(), 50);
} };
window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`;

async function openYouTubeSampleInStudio(browser: any, routeYouTube: boolean) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
  if (routeYouTube) {
    await ctx.route('**/iframe_api', (r: any) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT_API }));
    await ctx.route('https://www.youtube.com/embed/**', (r: any) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  } else {
    await ctx.route('https://www.youtube.com/**', (r: any) => r.abort());
  }
  const page = await ctx.newPage();
  await page.goto(srv.baseUrl);
  await page.getByRole('button', { name: /Get Started Free/ }).first().click();
  await page.getByRole('button', { name: /Guest/ }).click();
  await page.getByRole('button', { name: /Canvas & Timeline/ }).first().click();
  await page.getByText('YT Fill').waitFor();
  return { ctx, page };
}

test('E2E: captions follow the YouTube player clock and wait while it buffers', { skip, timeout: 120000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page } = await openYouTubeSampleInStudio(browser, true);
    const clock = async () => Number(await page.locator('input[type=range]').first().inputValue());
    await page.waitForTimeout(500); // let the player bind
    await page.getByRole('button', { name: 'Play preview' }).click();
    await page.waitForTimeout(1500);
    const duringBuffer = await clock();
    await page.waitForTimeout(2000);
    const afterStart = await clock();
    // Regression: the old timer ran ~1.5 s ahead here while YouTube was still buffering.
    assert.ok(duringBuffer < 0.2, `captions advanced to ${duringBuffer}s while the video was buffering`);
    assert.ok(afterStart > 0.8 && afterStart < 2.3, `captions at ${afterStart}s, expected ~1.5s of real playback`);
  } finally {
    await browser.close();
  }
});

test('E2E: uploaded source video exports real footage + original audio in sync with captions', { skip, timeout: 240000 }, async () => {
  const src = path.join(os.tmpdir(), `forge-src-${Date.now()}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x224466:s=1280x720:d=60:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=60:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const { page } = await openYouTubeSampleInStudio(browser, false);
    await page.getByRole('button', { name: 'Export Captions-Only Preview' }).waitFor();
    await page.locator('input[type=file][accept="video/*"]').setInputFiles(src);
    await page.getByText(/Source video: forge-src-/).waitFor();
    const timeline = Number((await page.innerText('body')).match(/([0-9.]+)s duration/)?.[1]);
    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.getByRole('button', { name: 'Export & Download Finished Short' }).click();
    const download = await dl;
    const out = path.join(os.tmpdir(), `forge-upload-${Date.now()}.${download.suggestedFilename().split('.').pop()}`);
    await download.saveAs(out);
    const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', out])
      .toString().trim().split('\n').map(Number).filter((n) => !isNaN(n));
    const last = Math.max(...pts);
    assert.ok(Math.abs(last - timeline) < 1.5, `exported ${last}s vs timeline ${timeline}s`);
    // Source footage is drawn (not a blank/placeholder frame): the test video's blue (0x224466) dominates.
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', '10', '-i', out, '-frames:v', '1', '-vf', 'crop=200:200:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.ok(rgb[2] > rgb[0] + 30, `frame is not the source footage (rgb ${[...rgb]})`);
    // Original audio is present (440 Hz tone), not silence.
    const vol = spawnSync('ffmpeg', ['-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
    const mean = Number(vol.match(/mean_volume: (-?[0-9.]+) dB/)?.[1] ?? -99);
    assert.ok(mean > -40, `exported audio is silent (mean ${mean} dB)`);
    fs.rmSync(out, { force: true });
  } finally {
    await browser.close();
    fs.rmSync(src, { force: true });
  }
});
