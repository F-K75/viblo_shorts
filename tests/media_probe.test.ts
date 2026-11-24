import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaEngineConfig } from '../server/media_engine/config.ts';
import { MediaEngineError } from '../server/media_engine/exceptions.ts';
import { MediaProbe } from '../server/media_engine/probe.ts';
import { getExportPreset, listExportPresets } from '../server/media_engine/presets/index.ts';
import { MediaStorage } from '../server/media_engine/storage.ts';
import { ensureGoldenMediaFixtures, type GoldenMediaFixtures } from './helpers/mediaFixtures.ts';

describe('Forge Media Engine — Probe, Storage Security & Export Presets', () => {
  let tmpDataDir = '';
  let fixtures: GoldenMediaFixtures;
  let storage: MediaStorage;
  let probe: MediaProbe;

  before(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-media-probe-'));
    fixtures = ensureGoldenMediaFixtures();
    const config = createMediaEngineConfig({ dataDir: tmpDataDir });
    storage = new MediaStorage(config);
    probe = new MediaProbe(config, storage);
  });

  after(() => {
    if (tmpDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  test('inspects 720p, 1080p, portrait, and landscape golden video fixtures accurately', async () => {
    const regPortrait = await storage.registerAssetFromFile({
      tenantId: 'tenant_alpha',
      sourceFilePath: fixtures.samplePortrait,
    });
    assert.match(regPortrait.record.id, /^asset_[a-f0-9]{32}$/);
    // Original asset file is immutable (read-only mode 0o444).
    const mode = fs.statSync(regPortrait.localPath).mode & 0o777;
    assert.equal(mode, 0o444);

    const portraitManifest = await probe.inspect(regPortrait.record, 'tenant_alpha');
    assert.equal(portraitManifest.width, 1080);
    assert.equal(portraitManifest.height, 1920);
    assert.equal(portraitManifest.aspectRatio, '9:16');
    assert.equal(portraitManifest.videoCodec, 'h264');
    assert.equal(portraitManifest.audioCodec, 'aac');
    assert.equal(portraitManifest.hasVideo, true);
    assert.equal(portraitManifest.hasAudio, true);
    assert.ok(portraitManifest.durationSeconds >= 3.8 && portraitManifest.durationSeconds <= 4.3);

    const landscapeManifest = await probe.inspectFile(fixtures.sampleLandscape, 'asset_landscape');
    assert.equal(landscapeManifest.width, 1920);
    assert.equal(landscapeManifest.height, 1080);
    assert.equal(landscapeManifest.aspectRatio, '16:9');
    assert.ok(landscapeManifest.durationSeconds >= 4.8);
  });

  test('detects missing audio stream on silent video and variable FPS on VFR fixture', async () => {
    const silentManifest = await probe.inspectFile(fixtures.sampleSilentVideo, 'asset_silent');
    assert.equal(silentManifest.hasVideo, true);
    assert.equal(silentManifest.hasAudio, false);
    assert.ok(silentManifest.warnings.some((w) => /no audio stream/i.test(w)));

    const vfrManifest = await probe.inspectFile(fixtures.sampleVariableFps, 'asset_vfr');
    assert.equal(vfrManifest.isVariableFps, true);
    assert.ok(vfrManifest.warnings.some((w) => /variable frame rate/i.test(w)));
  });

  test('inspects WAV, MP3, and SRT subtitle golden fixtures', async () => {
    const wavManifest = await probe.inspectFile(fixtures.sampleAudioWav, 'asset_wav');
    assert.equal(wavManifest.kind, 'audio');
    assert.equal(wavManifest.hasAudio, true);
    assert.equal(wavManifest.hasVideo, false);
    assert.equal(wavManifest.audioCodec, 'pcm_s16le');

    const mp3Manifest = await probe.inspectFile(fixtures.sampleMusicMp3, 'asset_mp3');
    assert.equal(mp3Manifest.kind, 'audio');
    assert.equal(mp3Manifest.audioCodec, 'mp3');
    assert.ok(mp3Manifest.durationSeconds >= 5.8);

    const srtManifest = await probe.inspectFile(fixtures.sampleSubtitlesSrt, 'asset_srt', 'subtitle');
    assert.equal(srtManifest.kind, 'subtitle');
    assert.equal(srtManifest.subtitleStreams[0]?.cueCount, 2);
    assert.ok(srtManifest.durationSeconds >= 3.8);
  });

  test('rejects corrupted media input with classified PROBE_ERROR', async () => {
    await assert.rejects(
      () => probe.inspectFile(fixtures.sampleCorrupted, 'asset_corrupt'),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'PROBE_ERROR',
    );
  });

  test('enforces tenant isolation, blocks symlink escapes, and rejects unsupported extensions', async () => {
    const { record } = await storage.registerAssetFromFile({
      tenantId: 'tenant_owner',
      sourceFilePath: fixtures.sample720p,
    });

    await assert.rejects(
      () => probe.inspect(record, 'tenant_intruder'),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR' && err.httpStatus === 403,
    );

    const symlinkPath = path.join(tmpDataDir, 'evil_link.mp4');
    fs.symlinkSync(fixtures.sample720p, symlinkPath);
    await assert.rejects(
      () => storage.registerAssetFromFile({ tenantId: 'tenant_owner', sourceFilePath: symlinkPath }),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
    );

    await assert.rejects(
      () =>
        storage.registerAssetFromBuffer({
          tenantId: 'tenant_owner',
          originalFilename: '../../etc/passwd.exe',
          data: Buffer.from('not-media'),
        }),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
    );
  });

  test('exposes all 6 specification export presets with valid dimensions and codecs', () => {
    const all = listExportPresets();
    assert.equal(all.length, 6);
    const reel = getExportPreset('instagram_reel');
    assert.equal(reel.width, 1080);
    assert.equal(reel.height, 1920);
    assert.equal(reel.fps, 30);
    assert.equal(reel.videoCodec, 'libx264');

    const yt4k = getExportPreset('youtube_4k');
    assert.equal(yt4k.width, 3840);
    assert.equal(yt4k.height, 2160);
    assert.ok(yt4k.allowedVideoCodecs.includes('libx265'));
    assert.ok(yt4k.allowedVideoCodecs.includes('libx264'));
  });
});
