import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaEngineConfig } from '../server/media_engine/config.ts';
import { MediaEngineError } from '../server/media_engine/exceptions.ts';
import type { MediaManifest } from '../server/media_engine/models.ts';
import { validateTimeline } from '../server/media_engine/timeline.ts';

const CLIP_1 = 'asset_11111111111111111111111111111111';
const CLIP_2 = 'asset_22222222222222222222222222222222';
const MUSIC_1 = 'asset_33333333333333333333333333333333';

function fakeVideoManifest(assetId: string, durationSeconds = 12): MediaManifest {
  return {
    assetId,
    kind: 'video',
    formatName: 'mov,mp4',
    durationSeconds,
    sizeBytes: 100_000,
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: 30,
    aspectRatio: '16:9',
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixelFormat: 'yuv420p',
    isVariableFps: false,
    videoStreams: [
      {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv420p',
        fps: 30,
        nominalFps: 30,
        avgFps: 30,
        isVariableFps: false,
        aspectRatio: '16:9',
        durationSeconds,
      },
    ],
    audioStreams: [{ index: 1, codec: 'aac', sampleRate: 44100, channels: 2, durationSeconds }],
    subtitleStreams: [],
    warnings: [],
    probedBy: 'ffmpeg',
    probedAt: new Date().toISOString(),
  };
}

function fakeAudioManifest(assetId: string, durationSeconds = 30): MediaManifest {
  return {
    assetId,
    kind: 'audio',
    formatName: 'mp3',
    durationSeconds,
    sizeBytes: 50_000,
    hasVideo: false,
    hasAudio: true,
    width: null,
    height: null,
    fps: null,
    aspectRatio: null,
    videoCodec: null,
    audioCodec: 'mp3',
    pixelFormat: null,
    isVariableFps: false,
    videoStreams: [],
    audioStreams: [{ index: 0, codec: 'mp3', sampleRate: 44100, channels: 2, durationSeconds }],
    subtitleStreams: [],
    warnings: [],
    probedBy: 'ffmpeg',
    probedAt: new Date().toISOString(),
  };
}

describe('Forge Media Engine — Timeline Contract Validation', () => {
  const config = createMediaEngineConfig();
  const baseCtx = {
    config,
    manifests: {
      [CLIP_1]: fakeVideoManifest(CLIP_1, 12),
      [CLIP_2]: fakeVideoManifest(CLIP_2, 12),
      [MUSIC_1]: fakeAudioManifest(MUSIC_1, 30),
    },
    resolvedAssetPaths: {
      [CLIP_1]: '/tmp/clip1.mp4',
      [CLIP_2]: '/tmp/clip2.mp4',
      [MUSIC_1]: '/tmp/music1.mp3',
    },
  };

  test('validates specification reel timeline, derives authoritative duration, and clamps trailing music', () => {
    const timeline = {
      project_id: 'media_001',
      format: 'instagram_reel',
      resolution: { width: 1080, height: 1920 },
      fps: 30,
      duration_seconds: 99, // Intentionally wrong AI value; must be overridden!
      tracks: {
        video: [
          { asset_id: CLIP_1, start: 0, end: 8, source_start: 2, source_end: 10, transition_out: 'fade' },
          { asset_id: CLIP_2, start: 8, end: 18, source_start: 0, source_end: 10 },
        ],
        audio: [
          { asset_id: MUSIC_1, start: 0, end: 30, volume: 0.25, fade_in: 1, fade_out: 2 },
        ],
        subtitles: [{ start: 0.5, end: 4.5, text: 'Hook line caption' }],
      },
      export: {
        container: 'mp4',
        video_codec: 'libx264',
        audio_codec: 'aac',
        pixel_format: 'yuv420p',
        video_bitrate: '8M',
      },
    };

    const validated = validateTimeline(timeline, baseCtx);
    assert.equal(validated.derivedDurationSeconds, 18);
    assert.equal(validated.spec.duration_seconds, 18);
    assert.equal(validated.spec.tracks.audio[0].end, 18);
    assert.equal(validated.subtitleTracks.length, 1);
    assert.ok(validated.warnings.some((w) => /overridden by derived timeline duration/i.test(w)));
  });

  test('rejects overlapping clips without explicit transition semantics', () => {
    const overlapping = {
      project_id: 'media_002',
      format: 'youtube_short',
      resolution: { width: 1080, height: 1920 },
      fps: 30,
      duration_seconds: 15,
      tracks: {
        video: [
          { asset_id: CLIP_1, start: 0, end: 8, source_start: 0, source_end: 8 },
          { asset_id: CLIP_2, start: 6, end: 14, source_start: 0, source_end: 8 }, // 2s overlap, no transition!
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
    };

    assert.throws(
      () => validateTimeline(overlapping, baseCtx),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'TIMELINE_ERROR' && /transition/i.test(err.message),
    );
  });

  test('rejects unsupported codecs, path-traversal asset IDs, and out-of-range source timestamps', () => {
    assert.throws(
      () =>
        validateTimeline(
          {
            project_id: 'media_003',
            format: 'instagram_reel',
            resolution: { width: 1080, height: 1920 },
            fps: 30,
            duration_seconds: 5,
            tracks: {
              video: [{ asset_id: '../../etc/passwd', start: 0, end: 5, source_start: 0, source_end: 5 }],
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
          baseCtx,
        ),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
    );

    assert.throws(
      () =>
        validateTimeline(
          {
            project_id: 'media_004',
            format: 'instagram_reel',
            resolution: { width: 1080, height: 1920 },
            fps: 30,
            duration_seconds: 5,
            tracks: {
              video: [{ asset_id: CLIP_1, start: 0, end: 5, source_start: 0, source_end: 5 }],
              audio: [],
              subtitles: [],
            },
            export: {
              container: 'mp4',
              video_codec: 'prores_ks',
              audio_codec: 'aac',
              pixel_format: 'yuv420p',
              video_bitrate: '8M',
            },
          },
          baseCtx,
        ),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'UNSUPPORTED_CODEC',
    );

    assert.throws(
      () =>
        validateTimeline(
          {
            project_id: 'media_005',
            format: 'instagram_reel',
            resolution: { width: 1080, height: 1920 },
            fps: 30,
            duration_seconds: 10,
            tracks: {
              video: [{ asset_id: CLIP_1, start: 0, end: 10, source_start: 8, source_end: 18 }], // source only 12s!
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
          baseCtx,
        ),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'TIMELINE_ERROR',
    );
  });
});
