import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FfmpegCommandBuilder } from '../server/media_engine/commandBuilder.ts';
import { createMediaEngineConfig } from '../server/media_engine/config.ts';
import { MediaEngineError } from '../server/media_engine/exceptions.ts';
import { serializeCuesToSrt } from '../server/media_engine/filterGraph.ts';
import { validateTimeline } from '../server/media_engine/timeline.ts';

const CLIP_A = 'asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUDIO_A = 'asset_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('Forge Media Engine — Safe Argument-Array Command Builder', () => {
  const config = createMediaEngineConfig({ maxThreads: 2 });
  const builder = new FfmpegCommandBuilder(config);

  test('enforces -nostdin, -protocol_whitelist file,pipe, and bounded threads on every command', () => {
    const vertical = builder.buildConvertVertical('/tmp/in.mp4', '/tmp/out.mp4');
    assert.ok(Array.isArray(vertical.args));
    assert.ok(vertical.args.includes('-nostdin'));
    const protoIdx = vertical.args.indexOf('-protocol_whitelist');
    assert.notEqual(protoIdx, -1);
    assert.equal(vertical.args[protoIdx + 1], 'file,pipe');

    const trim = builder.buildTrimVideo('/tmp/in.mp4', '/tmp/trim.mp4', 2.5, 4);
    assert.ok(trim.args.includes('2.500'));
    assert.ok(trim.args.includes('4.000'));

    const audio = builder.buildExtractAudio('/tmp/in.mp4', '/tmp/audio.mp3');
    assert.ok(audio.args.includes('-vn'));
    assert.ok(audio.args.includes('libmp3lame'));

    const loudnorm = builder.buildNormalizeAudio('/tmp/in.mp4', '/tmp/norm.mp4');
    assert.ok(loudnorm.args.includes('loudnorm=I=-16:TP=-1.5:LRA=11'));

    const thumb = builder.buildThumbnail('/tmp/in.mp4', '/tmp/thumb.jpg', 3);
    assert.ok(thumb.args.includes('-frames:v'));
    assert.ok(thumb.args.includes('1'));

    const fade = builder.buildFadeVideo('/tmp/in.mp4', '/tmp/fade.mp4', 1, 9, 1);
    assert.ok(fade.args.some((a) => a.includes('fade=t=in:st=0:d=1.000')));
  });

  test('builds multi-track timeline filter_complex with transitions, audio mixing, loudnorm, and burned subtitles', () => {
    const validated = validateTimeline(
      {
        project_id: 'media_cmd_01',
        format: 'instagram_reel',
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        duration_seconds: 4,
        tracks: {
          video: [{ asset_id: CLIP_A, start: 0, end: 4, source_start: 0, source_end: 4, transition_in: 'fade', transition_out: 'fade' }],
          audio: [{ asset_id: AUDIO_A, start: 0, end: 4, volume: 0.3, fade_in: 0.5, fade_out: 0.5, normalize_loudness: true }],
          subtitles: [{ start: 0.2, end: 3.5, text: 'Safe subtitle{\\an8} stripped' }],
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
        manifests: {
          [CLIP_A]: {
            assetId: CLIP_A,
            kind: 'video',
            formatName: 'mp4',
            durationSeconds: 5,
            sizeBytes: 10_000,
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
            videoStreams: [],
            audioStreams: [],
            subtitleStreams: [],
            warnings: [],
            probedBy: 'ffmpeg',
            probedAt: new Date().toISOString(),
          },
          [AUDIO_A]: {
            assetId: AUDIO_A,
            kind: 'audio',
            formatName: 'mp3',
            durationSeconds: 10,
            sizeBytes: 5_000,
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
            audioStreams: [],
            subtitleStreams: [],
            warnings: [],
            probedBy: 'ffmpeg',
            probedAt: new Date().toISOString(),
          },
        },
        resolvedAssetPaths: {
          [CLIP_A]: '/tmp/clip_a.mp4',
          [AUDIO_A]: '/tmp/audio_a.mp3',
        },
      },
    );

    const srt = serializeCuesToSrt(validated.subtitleTracks[0].cues);
    assert.ok(!srt.includes('{\\an8}'), 'ASS override tags must be stripped');

    const cmd = builder.buildTimelineRender(validated, '/tmp/rendered.mp4', {
      qualityProfile: 'high',
      stagedSubtitlePath: '/tmp/job_stage/captions.srt',
    });
    // P0-1 regression guard: EVERY `-i` must be immediately preceded by `-threads 2 -protocol_whitelist file,pipe`,
    // and output `-threads 2` must precede the output path.
    const inputFlagPositions = cmd.args.reduce<number[]>((acc, arg, idx) => (arg === '-i' ? [...acc, idx] : acc), []);
    assert.equal(inputFlagPositions.length, 2, 'timeline has 2 distinct input assets');
    for (const pos of inputFlagPositions) {
      assert.deepEqual(
        cmd.args.slice(pos - 4, pos),
        ['-threads', '2', '-protocol_whitelist', 'file,pipe'],
        `input at arg[${pos}] must carry per-input thread cap and protocol_whitelist`,
      );
    }
    const outIdx = cmd.args.indexOf('/tmp/rendered.mp4');
    assert.ok(outIdx > 3);
    assert.deepEqual(cmd.args.slice(outIdx - 4, outIdx - 2), ['-threads', '2']);

    const fcIndex = cmd.args.indexOf('-filter_complex');
    assert.notEqual(fcIndex, -1);
    const fc = cmd.args[fcIndex + 1];
    assert.ok(fc.includes('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'));
    assert.ok(fc.includes('loudnorm=I=-16:TP=-1.5:LRA=11'));
    assert.ok(fc.includes("subtitles=filename='/tmp/job_stage/captions.srt'"));
  });

  test('rejects relative paths and control characters in command arguments', () => {
    assert.throws(
      () => builder.buildThumbnail('relative/path.mp4', '/tmp/out.jpg', 1),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
    );
    assert.throws(
      () => builder.buildThumbnail('/tmp/evil\ninject.mp4', '/tmp/out.jpg', 1),
      (err: unknown) => err instanceof MediaEngineError && err.code === 'ASSET_ERROR',
    );
  });
});
