// Browser E2E: speaker-aware Vertical Fill. A 1280x720 source has its "speaker" (a wiggling skin-toned box) in the
// far LEFT third, where a centre 9:16 crop cuts it off entirely. With "Auto-frame speaker" on, the exported Short must
// show the box near the horizontal centre; with it off (the old centre crop) the box must be gone.
// Set SMART_CROP_SNAPSHOT_DIR to keep the before/after PNG frames.
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
const transcript = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/talk.transcript.txt'), 'utf8');

let srv: TestServer;
let tmp: string;
let sourceFile: string;
before(async () => {
  if (skip) return;
  srv = await startTestServer({
    NODE_ENV: 'production', TRUST_PROXY: 'none', CAPTCHA_REQUIRED: 'false', ...(TEST_BACKEND === 'json' ? { STORAGE_BACKEND: 'json' } : {}),
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smartcrop-'));
  sourceFile = path.join(tmp, 'speaker-left.mp4');
  // 62 s (the picked clip is 29.86 s → 58.56 s). Flat background; the "speaker" is a 200x320 skin-toned (0xE0AC69)
  // box centred ~250 px from the left edge that sways ±40 px, like someone talking and gesturing.
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=30:d=62',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=62',
    '-vf', "drawbox=x='150+40*sin(2*t)':y=200:w=200:h=320:color=0xE0AC69@1:t=fill",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceFile]);
});
after(async () => {
  await srv?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Extracts one frame at `sec` and measures the skin-toned box in the middle band: coverage and horizontal centre (0..1). */
function measureBox(video: string, sec: number, png: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(sec), '-i', video, '-frames:v', '1', png]);
  const W = 90;
  const H = 160;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  let hits = 0;
  let sumX = 0;
  let band = 0;
  // Rows 32 %–60 %: inside the box's vertical extent, clear of captions and the top bar.
  for (let y = Math.round(H * 0.32); y < Math.round(H * 0.6); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const d = Math.abs(raw[i] - 0xe0) + Math.abs(raw[i + 1] - 0xac) + Math.abs(raw[i + 2] - 0x69);
      band++;
      if (d < 60) {
        hits++;
        sumX += (x + 0.5) / W;
      }
    }
  }
  return { coverage: hits / band, centerX: hits ? sumX / hits : NaN };
}

async function exportShort(page: any, name: string) {
  const dl = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: /Export & Download Finished Short/ }).click();
  const download = await dl;
  const out = path.join(tmp, `${name}.${download.suggestedFilename().split('.').pop()}`);
  await download.saveAs(out);
  return out;
}

test('E2E: Vertical Fill auto-frames an off-centre speaker (centre crop would cut them off)', { skip, timeout: 420000 }, async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })).newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  const cspViolations = await watchCspViolations(page, srv.baseUrl); // the production CSP must not block these flows
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

    const autoFrame = page.getByLabel('Auto-frame speaker');
    assert.equal(await autoFrame.isChecked(), true, 'auto-frame is on by default');
    await page.getByLabel('Source video file').setInputFiles(sourceFile);
    await page.getByText('speaker-left.mp4').waitFor();
    await page.getByText('Speaker framed').waitFor({ timeout: 120000 });

    // The preview follows the speaker too: object-position moves the visible window to the left.
    const objPos = await page.locator('video').first().evaluate((v: HTMLVideoElement) => getComputedStyle(v).objectPosition);
    const pct = Number(/^([0-9.]+)%/.exec(objPos)?.[1]);
    assert.ok(pct < 15, `preview object-position ${objPos} should be near the left edge`);

    const framed = await exportShort(page, 'auto');
    await autoFrame.uncheck();
    const centred = await exportShort(page, 'centre');

    const dir = process.env.SMART_CROP_SNAPSHOT_DIR || tmp;
    fs.mkdirSync(dir, { recursive: true });
    for (const sec of [5, 15, 25]) {
      const a = measureBox(framed, sec, path.join(dir, `smartcrop-auto-${sec}s.png`));
      const c = measureBox(centred, sec, path.join(dir, `smartcrop-centre-${sec}s.png`));
      assert.ok(a.coverage > 0.2, `auto-frame at ${sec}s: speaker must be in frame (coverage ${a.coverage.toFixed(3)})`);
      assert.ok(Math.abs(a.centerX - 0.5) < 0.2, `auto-frame at ${sec}s: speaker near the centre (x ${a.centerX.toFixed(3)})`);
      assert.ok(c.coverage < 0.01, `centre crop at ${sec}s cuts the speaker off (coverage ${c.coverage.toFixed(3)})`);
    }
    assert.deepEqual(pageErrors, []);
    assert.equal(cspViolations.length, 0, `CSP violations:\n${formatViolations(cspViolations)}`);
  } finally {
    await browser.close();
  }
});
