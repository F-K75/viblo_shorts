import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMediaEngineConfig } from '../server/media_engine/config.ts';
import { MediaProbe } from '../server/media_engine/probe.ts';
import { validateTimeline } from '../server/media_engine/timeline.ts';
import { MediaValidator } from '../server/media_engine/validator.ts';
import { QualityAgent } from '../server/agents/media/qualityAgent.ts';
import { ensureGoldenMediaFixtures, type GoldenMediaFixtures } from './helpers/mediaFixtures.ts';

const ASSET_V = 'asset_12121212121212121212121212121212';

describe('Forge Media Engine — 5-Dimension QA Scorecard & Automated Repair Planning', () => {
  let tmpDir = '';
  let fixtures: GoldenMediaFixtures;
  let validator: MediaValidator;
  let qualityAgent: QualityAgent;
  let probe: MediaProbe;
  let ffmpegBin = '';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-media-qa-'));
    fixtures = ensureGoldenMediaFixtures();
    const config = createMediaEngineConfig({ dataDir: tmpDir });
    ffmpegBin = config.ffmpegBin;
    probe = new MediaProbe(config);
    validator = new MediaValidator(config, probe);
    qualityAgent = new QualityAgent(validator);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('scores clean portrait H.264+AAC video as publish-ready (>= 90/100)', async () => {
    const config = createMediaEngineConfig({ dataDir: tmpDir });
    const manifest = await probe.inspectFile(fixtures.samplePortrait, ASSET_V);
    const validated = validateTimeline(
      {
        project_id: 'media_qa_clean',
        format: 'instagram_reel',
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        duration_seconds: 4,
        tracks: {
          video: [{ asset_id: ASSET_V, start: 0, end: 4, source_start: 0, source_end: 4 }],
          audio: [],
          subtitles: [],
        },
        export: {
          container: 'mp4',
          video_codec: 'libx264',
          audio_codec: 'aac',
          pixel_format: 'yuv420p',
          video_bitrate: '8M',
        },
      },
      {
        config,
        manifests: { [ASSET_V]: manifest },
        resolvedAssetPaths: { [ASSET_V]: fixtures.samplePortrait },
      },
    );

    const { report } = await validator.evaluateRenderedVideo({
      jobId: 'job_qa_clean',
      projectId: 'media_qa_clean',
      outputPath: fixtures.samplePortrait,
      validatedTimeline: validated,
    });

    assert.ok(report.total_score >= 90, `expected >= 90, got ${report.total_score}: ${JSON.stringify(report)}`);
    assert.equal(report.band, 'publish_ready');
    assert.equal(report.passed, true);
    assert.equal(report.revision_required, false);
    assert.equal(report.metrics.total_black_duration, 0);
  });

  test('detects black frames, static freezes, and silent audio, and generates a targeted repair timeline', async () => {
    // Synthesize a defective render: 2.5s solid black + frozen + silent audio
    const defectivePath = path.join(tmpDir, 'defective_black_silent.mp4');
    execFileSync(
      ffmpegBin,
      [
        '-y',
        '-nostdin',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:r=30:d=3',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t', '3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        defectivePath,
      ],
      { stdio: 'ignore' },
    );

    const config = createMediaEngineConfig({ dataDir: tmpDir });
    const srcManifest = await probe.inspectFile(fixtures.samplePortrait, ASSET_V);
    // Timeline with an unintended gap (0..1s and 2..3s -> 1s black gap!)
    const gappedValidated = validateTimeline(
      {
        project_id: 'media_qa_defective',
        format: 'instagram_reel',
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        duration_seconds: 3,
        tracks: {
          video: [
            { asset_id: ASSET_V, start: 0, end: 1, source_start: 0, source_end: 1, mute_source_audio: true, volume: 0 },
            { asset_id: ASSET_V, start: 2, end: 3, source_start: 1, source_end: 2, mute_source_audio: true, volume: 0 },
          ],
          audio: [],
          subtitles: [],
        },
        export: {
          container: 'mp4',
          video_codec: 'libx264',
          audio_codec: 'aac',
          pixel_format: 'yuv420p',
          video_bitrate: '8M',
        },
      },
      {
        config,
        manifests: { [ASSET_V]: srcManifest },
        resolvedAssetPaths: { [ASSET_V]: fixtures.samplePortrait },
      },
    );

    const { report } = await validator.evaluateRenderedVideo({
      jobId: 'job_qa_defective',
      projectId: 'media_qa_defective',
      outputPath: defectivePath,
      validatedTimeline: gappedValidated,
      expectAudioActivity: true,
    });

    assert.ok(report.metrics.total_black_duration >= 2.5, `black=${report.metrics.total_black_duration}`);
    assert.ok(report.metrics.total_freeze_duration >= 2.0, `freeze=${report.metrics.total_freeze_duration}`);
    assert.equal(report.metrics.audio_silent_detected, true);
    assert.ok(report.total_score < 65, `expected < 65, got ${report.total_score}`);
    assert.equal(report.revision_required, true);

    const repair = qualityAgent.buildRepairTimeline(gappedValidated.spec, report);
    assert.equal(repair.canRepair, true);
    assert.ok(repair.repairedTimeline !== null);
    // Verify clips were snapped together (no gap) and audio was restored!
    assert.equal(repair.repairedTimeline!.tracks.video[0].start, 0);
    assert.equal(repair.repairedTimeline!.tracks.video[1].start, repair.repairedTimeline!.tracks.video[0].end);
    assert.equal(repair.repairedTimeline!.tracks.video[0].mute_source_audio, false);
  });
});
