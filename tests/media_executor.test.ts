import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FfmpegCommandBuilder } from '../server/media_engine/commandBuilder.ts';
import { createMediaEngineConfig } from '../server/media_engine/config.ts';
import { MediaEngineError } from '../server/media_engine/exceptions.ts';
import { FfmpegExecutor } from '../server/media_engine/executor.ts';
import { MediaProbe } from '../server/media_engine/probe.ts';
import { ensureGoldenMediaFixtures, type GoldenMediaFixtures } from './helpers/mediaFixtures.ts';

describe('Forge Media Engine — Real FFmpeg Execution, Atomic Operations & Cancellation', () => {
  let tmpDir = '';
  let fixtures: GoldenMediaFixtures;
  let builder: FfmpegCommandBuilder;
  let executor: FfmpegExecutor;
  let probe: MediaProbe;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-media-exec-'));
    fixtures = ensureGoldenMediaFixtures();
    const config = createMediaEngineConfig({ dataDir: tmpDir });
    builder = new FfmpegCommandBuilder(config);
    executor = new FfmpegExecutor(config);
    probe = new MediaProbe(config);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('executes landscape-to-portrait 9:16 conversion, trim, audio extraction, loudnorm, fade, subtitle burn, and thumbnail', async () => {
    // 1. Convert 1920x1080 landscape to 1080x1920 vertical
    const verticalOut = path.join(tmpDir, 'vertical.mp4');
    const progressUpdates: number[] = [];
    await executor.execute(builder.buildConvertVertical(fixtures.sampleLandscape, verticalOut), {
      jobId: 'exec_vertical',
      expectedDurationSeconds: 5,
      onProgress: (pct) => progressUpdates.push(pct),
    });
    const verticalMeta = await probe.inspectFile(verticalOut, 'asset_v');
    assert.equal(verticalMeta.width, 1080);
    assert.equal(verticalMeta.height, 1920);
    assert.equal(verticalMeta.videoCodec, 'h264');
    assert.ok(progressUpdates.length > 0 && progressUpdates.includes(100));

    // 2. Trim video at exact timestamps (1.0s to 3.0s -> 2.0s duration)
    const trimOut = path.join(tmpDir, 'trimmed.mp4');
    await executor.execute(builder.buildTrimVideo(fixtures.sample1080p, trimOut, 1.0, 2.0), {
      jobId: 'exec_trim',
      expectedDurationSeconds: 2,
    });
    const trimMeta = await probe.inspectFile(trimOut, 'asset_trim');
    assert.ok(Math.abs(trimMeta.durationSeconds - 2.0) < 0.25, `expected ~2.0s, got ${trimMeta.durationSeconds}s`);

    // 3. Extract MP3 audio
    const mp3Out = path.join(tmpDir, 'extracted.mp3');
    await executor.execute(builder.buildExtractAudio(fixtures.sample720p, mp3Out), {
      jobId: 'exec_mp3',
    });
    const mp3Meta = await probe.inspectFile(mp3Out, 'asset_mp3');
    assert.equal(mp3Meta.hasAudio, true);
    assert.equal(mp3Meta.hasVideo, false);
    assert.equal(mp3Meta.audioCodec, 'mp3');

    // 4. Burn SRT subtitles into video
    const subOut = path.join(tmpDir, 'subtitled.mp4');
    await executor.execute(builder.buildBurnSubtitles(fixtures.sample720p, fixtures.sampleSubtitlesSrt, subOut), {
      jobId: 'exec_sub',
    });
    const subMeta = await probe.inspectFile(subOut, 'asset_sub');
    assert.equal(subMeta.hasVideo, true);
    assert.ok(subMeta.sizeBytes > 1000);

    // 5. Normalize audio loudness
    const normOut = path.join(tmpDir, 'normalized.mp4');
    await executor.execute(builder.buildNormalizeAudio(fixtures.sample720p, normOut), {
      jobId: 'exec_norm',
    });
    const normMeta = await probe.inspectFile(normOut, 'asset_norm');
    assert.equal(normMeta.hasAudio, true);

    // 6. Generate JPEG thumbnail
    const thumbOut = path.join(tmpDir, 'thumb.jpg');
    await executor.execute(builder.buildThumbnail(fixtures.sample720p, thumbOut, 1.5), {
      jobId: 'exec_thumb',
    });
    assert.ok(fs.existsSync(thumbOut) && fs.statSync(thumbOut).size > 500);

    // 7. Add fade-in and fade-out
    const fadeOut = path.join(tmpDir, 'faded.mp4');
    await executor.execute(builder.buildFadeVideo(fixtures.sample720p, fadeOut, 0.5, 3.0, 0.8), {
      jobId: 'exec_fade',
    });
    const fadeMeta = await probe.inspectFile(fadeOut, 'asset_fade');
    assert.equal(fadeMeta.hasVideo, true);
  });

  test('supports instant SIGKILL cancellation via AbortSignal and cleans up partial output', async () => {
    const cancelOut = path.join(tmpDir, 'cancelled.mp4');
    const abortCtrl = new AbortController();
    // Long synthetic lavfi render so we can abort mid-flight deterministically
    const slowCmd = {
      binary: createMediaEngineConfig().ffmpegBin,
      outputPath: cancelOut,
      args: [
        '-nostdin',
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc2=size=1920x1080:rate=60:duration=120',
        '-c:v', 'libx264',
        '-preset', 'slow',
        cancelOut,
      ],
    };
    setTimeout(() => abortCtrl.abort(), 120);

    await assert.rejects(
      () =>
        executor.execute(slowCmd, {
          jobId: 'exec_cancel_1',
          expectedDurationSeconds: 120,
          signal: abortCtrl.signal,
        }),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'RENDER_TIMEOUT',
    );
    assert.equal(fs.existsSync(cancelOut), false, 'partial output file must be cleaned up on cancellation');
    assert.equal(executor.runningCount, 0);
  });
});
