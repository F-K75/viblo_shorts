// Browser E2E: YouTube link + pasted transcript → best clip candidates → user's own video file → export.
// Verifies the exported clip uses the real footage window (duration), carries the source audio (not silence),
// and that the transcript picker chose the right moment. The source video is generated locally with ffmpeg.
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

let srv: TestServer;
let tmp: string;
let sourceFile: string;
before(async () => {
  if (skip) return;
  srv = await startTestServer({
    NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}),
    // Optional YouTube footage download, with a stand-in yt-dlp that produces a real MP4 of the requested section.
    YOUTUBE_DOWNLOAD_ENABLED: 'true', YTDLP_PATH: path.resolve(import.meta.dirname, '../fixtures/fake-yt-dlp.sh'),
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-clip-'));
  sourceFile = path.join(tmp, 'source.mp4');
  // 135 s landscape source with a continuous 440 Hz tone standing in for speech.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=135', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=135',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile]);
});
after(async () => {
  await srv?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('E2E: YouTube link + transcript → best clip → own video file → export with real audio', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  try {
    await page.goto(srv.baseUrl);
    await page.getByRole('button', { name: /Get Started Free/ }).first().click();
    await page.getByRole('button', { name: /Guest/ }).click();
    await page.getByRole('heading', { name: 'YouTube Video to Clips' }).click();
    await page.getByPlaceholder(/Paste YouTube link/).fill('https://www.youtube.com/watch?v=arj7oStGLkU');
    await page.getByRole('button', { name: 'Add custom CC' }).click();
    await page.getByPlaceholder(/Paste transcript/).fill(transcript);
    await page.getByRole('button', { name: /^Analyze$/ }).click();
    await page.getByText(/Clip Candidates/).first().waitFor({ timeout: 60000 });

    const cards = page.locator('[data-clip-candidate]');
    assert.equal(await cards.count(), 3);
    assert.match(await cards.first().innerText(), /Why does your to-do list never actually get done\?/);
    await cards.first().click();
    await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();

    await page.getByLabel('Source video file').setInputFiles(sourceFile);
    await page.getByText('source.mp4').waitFor();
    await page.getByText(/footage and original audio/).waitFor();

    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    const download = await dl;
    const out = path.join(tmp, `clip.${download.suggestedFilename().split('.').pop()}`);
    await download.saveAs(out);

    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    assert.ok(Math.abs(dur - 28.7) < 2, `clip duration ${dur}s, expected ~28.7s (29.86s → 58.56s of the source)`);
    const log = spawnSync('ffmpeg', ['-nostdin', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[0-9.]+)/.exec(log)?.[1]);
    assert.ok(mean > -35, `source audio must be in the export (mean ${mean} dB)`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('E2E: YouTube clip → "Get this clip\'s footage from YouTube" (rights confirmed) → export with footage + audio', { skip, timeout: 240000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  try {
    await page.goto(srv.baseUrl);
    await page.getByRole('button', { name: /Get Started Free/ }).first().click();
    await page.getByRole('button', { name: /Guest/ }).click();
    await page.getByRole('heading', { name: 'YouTube Video to Clips' }).click();
    await page.getByPlaceholder(/Paste YouTube link/).fill('https://www.youtube.com/watch?v=arj7oStGLkU');
    await page.getByRole('button', { name: 'Add custom CC' }).click();
    await page.getByPlaceholder(/Paste transcript/).fill(transcript);
    await page.getByRole('button', { name: /^Analyze$/ }).click();
    await page.getByText(/Clip Candidates/).first().waitFor({ timeout: 60000 });
    await page.locator('[data-clip-candidate]').first().click();
    await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();

    const getFootage = page.getByRole('button', { name: /footage from YouTube/ });
    assert.equal(await getFootage.isDisabled(), true, 'rights must be confirmed first');
    await page.getByLabel(/I own this video or have permission/).check();
    await getFootage.click();
    await page.getByText(/YouTube footage \(15s–74s\)/).waitFor({ timeout: 60000 });

    const dl = page.waitForEvent('download', { timeout: 180000 });
    await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
    const download = await dl;
    const out = path.join(tmp, `yt.${download.suggestedFilename().split('.').pop()}`);
    await download.saveAs(out);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    assert.ok(Math.abs(dur - 28.7) < 2, `clip duration ${dur}s`);
    const log = spawnSync('ffmpeg', ['-nostdin', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[0-9.]+)/.exec(log)?.[1]);
    assert.ok(mean > -35, `downloaded audio must be in the export (mean ${mean} dB)`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
