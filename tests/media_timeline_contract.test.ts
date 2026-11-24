import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getMediaTimelineDurationMs,
  MEDIA_TIMELINE_LIMITS,
  MEDIA_TIMELINE_PRESETS,
  MediaTimelineValidationError,
  parseAssetId,
  parseMediaTimeline,
} from '../server/media/timeline.ts';

function reel() {
  return {
    schemaVersion: '1.0',
    preset: 'vertical-1080p',
    video: Array.from({ length: 5 }, (_, i) => ({
      assetId: `asset_clip_${i + 1}`,
      startMs: i * 2_000,
      endMs: (i + 1) * 2_000,
      sourceStartMs: 50,
      sourceEndMs: 2_050,
    })),
    captions: [
      { startMs: 100, endMs: 1_900, text: 'Let’s start.' },
      { startMs: 5_000, endMs: 8_500, text: 'A grounded, ordered edit.' },
    ],
    music: {
      assetId: 'asset_music-1',
      startMs: 0,
      endMs: 10_000,
      sourceStartMs: 1_000,
      sourceEndMs: 11_000,
      gain: 0.25,
    },
  };
}

function invalid(input: unknown, field: string): void {
  assert.throws(() => parseMediaTimeline(input), { name: 'MediaTimelineValidationError', field });
}

test('Media timeline accepts five cuts, timed captions and music as an immutable round-trip document', () => {
  const input = reel();
  const parsed = parseMediaTimeline(input);
  assert.deepEqual(parsed, input);
  assert.deepEqual(parseMediaTimeline(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(getMediaTimelineDurationMs(parsed), 10_000);
  assert.deepEqual(MEDIA_TIMELINE_PRESETS[parsed.preset], { width: 1080, height: 1920, fps: 30 });
  const { music: _music, ...withoutMusic } = input;
  const preview = parseMediaTimeline({ ...withoutMusic, preset: 'vertical-720p', captions: [] });
  assert.equal(preview.music, undefined);
  assert.deepEqual(MEDIA_TIMELINE_PRESETS[preview.preset], { width: 720, height: 1280, fps: 30 });

  input.video[0].assetId = 'asset_replaced';
  assert.equal(parsed.video[0].assetId, 'asset_clip_1');
  for (const value of [parsed, parsed.video, ...parsed.video, parsed.captions, ...parsed.captions, parsed.music]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('Media timeline rejects unknown fields, invalid asset IDs and unbounded shapes', () => {
  const input = reel();
  invalid(null, 'timeline');
  invalid({ ...input, schemaVersion: '1.1' }, 'timeline.schemaVersion');
  invalid({ ...input, preset: 'toString' }, 'timeline.preset');
  invalid({ ...input, durationMs: 10_000 }, 'timeline');
  invalid(JSON.parse(JSON.stringify(input).replace('"music":{', '"__proto__":{},"music":{')), 'timeline');
  invalid({ ...input, video: [{ ...input.video[0], command: 'literal' }] }, 'timeline.video[0]');
  invalid({ ...input, captions: [{ ...input.captions[0], color: 'red' }] }, 'timeline.captions[0]');
  invalid({ ...input, music: null }, 'timeline.music');
  invalid({ ...input, video: [] }, 'timeline.video');
  invalid({ ...input, video: new Array(1) }, 'timeline.video[0]');
  invalid({ ...input, video: [...input.video, input.video[0]] }, 'timeline.video');
  invalid({ ...input, captions: Array(101).fill(input.captions[0]) }, 'timeline.captions');

  assert.equal(parseAssetId('asset_abc123_-'), 'asset_abc123_-');
  for (const id of ['asset_', `asset_${'a'.repeat(65)}`, 'asset_a\n', 'asset_a/b', 'asset_a:b', 'asset_%61', '/tmp/file.mp4', 'https://media.example/test.mp4']) {
    assert.throws(() => parseAssetId(id), MediaTimelineValidationError);
  }
});

test('Media timeline requires contiguous, ordered cuts and a matching positive source window', () => {
  const input = reel();
  const video = input.video;
  invalid({ ...input, video: [...video].reverse() }, 'timeline.video[0].startMs');
  invalid({ ...input, video: [video[0], { ...video[1], startMs: 1_999, endMs: 3_999 }] }, 'timeline.video[1].startMs');
  invalid({ ...input, video: [video[0], { ...video[1], startMs: 2_001, endMs: 4_001 }] }, 'timeline.video[1].startMs');
  invalid({ ...input, video: [{ ...video[0], sourceEndMs: 2_000 }] }, 'timeline.video[0].sourceEndMs');
  invalid({ ...input, video: [{ ...video[0], endMs: 0 }] }, 'timeline.video[0].endMs');
  invalid({ ...input, video: [{ ...video[0], startMs: 0.5 }] }, 'timeline.video[0].startMs');
  invalid({ ...input, video: [{ ...video[0], endMs: NaN }] }, 'timeline.video[0].endMs');
  invalid({ ...input, video: [{ ...video[0], endMs: '2000' }] }, 'timeline.video[0].endMs');
  invalid({ ...input, video: [{ ...video[0], startMs: -1 }] }, 'timeline.video[0].startMs');
  invalid({ ...input, video: [{ ...video[0], endMs: 60_001 }] }, 'timeline.video[0].endMs');
  invalid({ ...input, video: [{ ...video[0], sourceEndMs: MEDIA_TIMELINE_LIMITS.sourceTimestampMs + 1 }] }, 'timeline.video[0].sourceEndMs');
});

test('Media timeline keeps captions and music inside the edit and bounds caption text and music gain', () => {
  const input = reel();
  invalid({ ...input, captions: [...input.captions].reverse() }, 'timeline.captions[1].startMs');
  invalid({ ...input, captions: [{ ...input.captions[0], endMs: 10_001 }] }, 'timeline.captions[0].endMs');
  for (const caption of [' ', 'line\nline', 'line\u0000', 'x'.repeat(161)]) {
    invalid({ ...input, captions: [{ ...input.captions[0], text: caption }] }, 'timeline.captions[0].text');
  }
  invalid({ ...input, music: { ...input.music, endMs: 10_001 } }, 'timeline.music.endMs');
  invalid({ ...input, music: { ...input.music, sourceStartMs: 1_001 } }, 'timeline.music.sourceEndMs');
  for (const gain of [-0.01, 1.01, Infinity, '0.25']) {
    invalid({ ...input, music: { ...input.music, gain } }, 'timeline.music.gain');
  }
});
