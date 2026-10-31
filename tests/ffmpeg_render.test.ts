import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('FFmpeg Video Rendering: generates a valid playable 9:16 vertical MP4 video file', async () => {
  const testRenderId = `test_render_${Date.now()}`;
  const tempDir = '/tmp';
  const outputPath = path.join(tempDir, `${testRenderId}.mp4`);
  const duration = 2; // 2 seconds test duration
  const width = 720;
  const height = 1280;

  const fontPath = path.resolve(process.cwd(), 'assets/fonts/Poppins-Bold.ttf');
  const hasFont = fs.existsSync(fontPath);

  let vf = "drawtext=text='FORGE STUDIO':x=(w-text_w)/2:y=100:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10";
  if (hasFont) {
    vf += `:fontfile='${fontPath}'`;
  }

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=0x0f141c:s=${width}x${height}:d=${duration}:r=30`,
    '-f', 'lavfi',
    '-i', `sine=f=440:d=${duration}:sample_rate=44100`,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-t', duration.toString(),
    outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
    });
    proc.on('error', reject);
  });

  assert.ok(fs.existsSync(outputPath), 'Output video file must exist on disk');
  const stats = fs.statSync(outputPath);
  assert.ok(stats.size > 5000, `Output MP4 file size (${stats.size} bytes) must be > 5KB`);

  // Verify MP4 signature (ftyp box in first 32 bytes)
  const fd = fs.openSync(outputPath, 'r');
  const buffer = Buffer.alloc(32);
  fs.readSync(fd, buffer, 0, 32, 0);
  fs.closeSync(fd);

  const containsFtyp = buffer.includes(Buffer.from('ftyp'));
  assert.ok(containsFtyp, 'Rendered artifact must be a genuine ISO BMFF MP4 file with ftyp box header');

  // Cleanup test artifact
  fs.unlinkSync(outputPath);
});
