/**
 * Produces a finished Short end-to-end through the real UI (guest → idea → script → export) and saves the MP4.
 * Usage: npm run build && npm run make-video -- "your idea" [output-dir]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startTestServer } from '../tests/helpers/server.ts';

const idea = process.argv[2] || '5 science-backed habits to fall asleep faster';
const outDir = path.resolve(process.argv[3] || 'output');
fs.mkdirSync(outDir, { recursive: true });

const srv = await startTestServer({ NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', STORAGE_BACKEND: 'json' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  await page.goto(srv.baseUrl);
  await page.getByRole('button', { name: /Get Started Free/ }).first().click();
  await page.getByRole('button', { name: /Guest/ }).click();
  await page.getByRole('heading', { name: 'Idea Prompt to Short' }).click();
  await page.locator('input').first().fill(idea);
  await page.getByRole('button', { name: /Generate Script/i }).click();
  await page.getByText(/Clip Strategies & Clip Trimmer/).first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /Canvas & Timeline/ }).first().click();
  await page.waitForTimeout(3000); // let media load
  await page.screenshot({ path: path.join(outDir, 'editor.png') });
  console.log('Exporting (takes about the video length)...');
  const dl = page.waitForEvent('download', { timeout: 300000 });
  await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
  const download = await dl;
  const raw = path.join(outDir, `raw_${download.suggestedFilename()}`);
  await download.saveAs(raw);
  // Normalise to a universally playable MP4 (H.264 + AAC, faststart, constant 30 fps, YouTube loudness -14 LUFS).
  const final = path.join(outDir, 'forge_short.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final]);
  fs.rmSync(raw);
  console.log('Saved', final);
} finally {
  await browser.close();
  await srv.stop();
}
