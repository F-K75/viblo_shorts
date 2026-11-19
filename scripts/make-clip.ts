/**
 * Turns a long video into a finished vertical clip through the real UI:
 * YouTube link + transcript → clip candidates → pick one → attach your own copy of the video → export MP4.
 *
 * Usage (after `npm run build`):
 *   npm run make-clip -- --url <youtube-url> --source <your-video.mp4> [--transcript <timed-transcript.txt>]
 *                        [--clip 1] [--fit] [--out output]
 *   npm run make-clip -- --url <youtube-url> --download --i-have-rights [...]   # footage via yt-dlp (must be installed)
 *
 * --transcript: YouTube "Show transcript" text (or any "m:ss" timed text). Without it the server tries YouTube CC.
 * --clip:       which candidate to export (1 = best). --fit: letterbox instead of centre-crop.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startTestServer } from '../tests/helpers/server.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = opt('url');
const source = opt('source');
const fromYouTube = args.includes('--download');
if (!url || (!source && !fromYouTube)) {
  console.error('Usage: npm run make-clip -- --url <youtube-url> (--source <video-file> | --download --i-have-rights) [--transcript <file>] [--clip N] [--fit] [--out dir]');
  process.exit(2);
}
if (fromYouTube && !args.includes('--i-have-rights')) {
  console.error('--download needs --i-have-rights: only download videos you own or have permission to use (YouTube Terms of Service).');
  process.exit(2);
}
const transcript = opt('transcript') ? fs.readFileSync(opt('transcript')!, 'utf8') : '';
const clipNo = Math.max(1, Number(opt('clip') || 1));
const outDir = path.resolve(opt('out') || 'output');
fs.mkdirSync(outDir, { recursive: true });

const srv = await startTestServer({
  NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', STORAGE_BACKEND: 'json',
  ...(fromYouTube ? { YOUTUBE_DOWNLOAD_ENABLED: 'true' } : {}),
});
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(srv.baseUrl);
  await page.getByRole('button', { name: /Get Started Free/ }).first().click();
  await page.getByRole('button', { name: /Guest/ }).click();
  await page.getByRole('heading', { name: 'YouTube Video to Clips' }).click();
  await page.getByPlaceholder(/Paste YouTube link/).fill(url);
  if (transcript) {
    await page.getByRole('button', { name: 'Add custom CC' }).click();
    await page.getByPlaceholder(/Paste transcript/).fill(transcript);
  }
  await page.getByRole('button', { name: /^Analyze$/ }).click();
  await page.getByText(/Clip Candidates/).first().waitFor({ timeout: 90000 });

  const cards = page.locator('[data-clip-candidate]');
  const count = await cards.count();
  console.log(`Candidates (${count}):`);
  for (let i = 0; i < count; i++) console.log(`  ${i + 1}. ${(await cards.nth(i).innerText()).split('\n').slice(0, 3).join(' | ')}`);
  await cards.nth(Math.min(clipNo, count) - 1).click();
  await page.getByRole('button', { name: /Continue to Studio Canvas/ }).first().click();

  if (fromYouTube) {
    console.log('Downloading the clip section from YouTube (yt-dlp)...');
    await page.getByLabel(/I own this video or have permission/).check();
    await page.getByRole('button', { name: /footage from YouTube/ }).click();
    const done = page.getByText(/^YouTube footage \(/);
    const failed = page.locator('[role=alert]');
    await Promise.race([done.waitFor({ timeout: 360000 }), failed.waitFor({ timeout: 360000 })]);
    if (await failed.isVisible()) throw new Error(await failed.innerText());
  } else {
    await page.getByLabel('Source video file').setInputFiles(path.resolve(source!));
  }
  if (args.includes('--fit')) await page.getByRole('button', { name: 'Letterbox Fit' }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, 'clip_editor.png') });

  console.log('Exporting (takes about the clip length)...');
  const dl = page.waitForEvent('download', { timeout: 300000 });
  await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
  const download = await dl;
  const raw = path.join(outDir, `raw_${download.suggestedFilename()}`);
  await download.saveAs(raw);
  const final = path.join(outDir, `forge_clip_${clipNo}.mp4`);
  // Universal MP4 (H.264/AAC, faststart, CFR 30), loudness-normalised to YouTube's -14 LUFS.
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final]);
  fs.rmSync(raw);
  console.log('Saved', final);
} finally {
  await browser.close();
  await srv.stop();
}
