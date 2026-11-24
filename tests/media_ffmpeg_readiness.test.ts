import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { checkFfmpegReadiness } from '../server/media/ffmpegReadiness.ts';

function fixture(t: TestContext, name: string, body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'forge-media-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, name);
  const checkArguments = 'test "$#" = 1 && test "$1" = -version || exit 99';
  writeFileSync(binary, `#!/bin/sh\n${checkArguments}\n${body}\n`, { mode: 0o700 });
  return binary;
}

test('FFmpeg readiness requires both tools and returns bounded version metadata', async (t) => {
  const ffmpegPath = fixture(t, 'ffmpeg with spaces', "printf 'ffmpeg version 7.1 Copyright\\nconfigured flags\\n'");
  const ffprobePath = fixture(t, 'ffprobe', "printf 'ffprobe version 7.1-1ubuntu1 Copyright\\n'");
  const result = await checkFfmpegReadiness({ ffmpegPath, ffprobePath });
  assert.equal(result.status, 'ready');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(result.ffmpeg, { status: 'ready', version: '7.1' });
  assert.deepEqual(result.ffprobe, { status: 'ready', version: '7.1-1ubuntu1' });
});

test('FFmpeg readiness reports missing tools and nonzero exits without diagnostics', async (t) => {
  const ffmpegPath = `${fixture(t, 'existing', 'exit 99')}.missing`;
  const ffprobePath = fixture(t, 'ffprobe', "printf '/private/operator/path\\n' >&2\nexit 42");
  const result = await checkFfmpegReadiness({ ffmpegPath, ffprobePath });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.ffmpeg, { status: 'unavailable', reason: 'missing' });
  assert.deepEqual(result.ffprobe, { status: 'unavailable', reason: 'nonzero_exit' });
});

test('FFmpeg readiness terminates a probe that exceeds its deadline', async (t) => {
  const ffmpegPath = fixture(t, 'slow', 'exec /bin/sleep 10');
  const result = await checkFfmpegReadiness({ ffmpegPath, timeoutMs: 500 });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.ffmpeg, { status: 'unavailable', reason: 'timeout' });
});

test('FFmpeg readiness bounds subprocess output', async (t) => {
  const ffprobePath = fixture(t, 'noisy', 'exec /bin/dd if=/dev/zero bs=32768 count=1');
  const result = await checkFfmpegReadiness({ ffprobePath });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.ffprobe, { status: 'unavailable', reason: 'output_limit' });
});

test('FFmpeg readiness rejects an unexpected version banner and invalid overrides', async (t) => {
  const ffmpegPath = fixture(t, 'wrong', "printf 'ffprobe version 7.1\\n'");
  const ffprobePath = fixture(t, 'ffprobe', "printf 'ffprobe version 7.1\\n'");
  const result = await checkFfmpegReadiness({ ffmpegPath, ffprobePath });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.ffmpeg, { status: 'unavailable', reason: 'bad_version' });
  assert.deepEqual(result.ffprobe, { status: 'ready', version: '7.1' });
  await assert.rejects(checkFfmpegReadiness({ ffmpegPath: './ffmpeg' }), /absolute path/);
  await assert.rejects(checkFfmpegReadiness({ timeoutMs: 0 }), /timeout/);
});
