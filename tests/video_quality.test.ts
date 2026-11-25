// Comprehensive real-video regression test suite for Forge Reel Quality Evaluation Engine.
// Covers all 12 required scenarios using real FFmpeg-generated MP4 fixtures (no mocked probes or fabricated scores).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeMedia, detectFaststart, dHashFrames } from '../server/lib/videoQuality/probe.ts';
import { evaluate, evaluatePreflight, loadThresholds } from '../server/lib/videoQuality/evaluator.ts';
import { evaluateCaptions, missingWords, tokens } from '../server/lib/videoQuality/captionQuality.ts';
import { hamming, repeatedShots, segmentShots } from '../server/lib/videoQuality/similarity.ts';
import type { MediaFacts, Timeline } from '../server/lib/videoQuality/models.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-'));
const f = (n: string) => path.join(tmp, n);
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);

const SCRIPT = 'Why does your to-do list never get done? It is not because you are lazy. Pick one task every morning. Follow this rule and do it first today.';
const BEATS = [
  { text: 'Why does your to-do list never get done?', start_s: 0, end_s: 2.2, role: 'hook' as const },
  { text: 'It is not because you are lazy.', start_s: 2.2, end_s: 4.1, role: 'context' as const },
  { text: 'Pick one task every morning.', start_s: 4.1, end_s: 6.0, role: 'progression' as const },
  { text: 'Follow this rule and do it first today.', start_s: 6.0, end_s: 8.0, role: 'cta' as const },
];
const phraseChunks = BEATS.map((b) => {
  const words = b.text.split(' ');
  const dur = (b.end_s - b.start_s - 0.1) / words.length;
  return {
    text: b.text,
    start_s: +(b.start_s + 0.05).toFixed(2),
    end_s: +(b.end_s - 0.05).toFixed(2),
    words: words.length,
    lines: 2,
    wordTimings: words.map((w, idx) => ({
      word: w,
      start_s: +(b.start_s + 0.05 + idx * dur).toFixed(2),
      end_s: +(b.start_s + 0.05 + (idx + 1) * dur - 0.02).toFixed(2),
    })),
  };
});
const timeline = (over: Partial<Timeline> = {}): Timeline => ({
  durationS: 8,
  scriptText: SCRIPT,
  beats: BEATS.map((b, i) => ({
    ...b,
    asset: `clip-${i}`,
    kind: 'broll' as const,
    visual_keywords: ['list task', 'lazy person', 'morning task', 'rule today'][i],
  })),
  captions: { enabled: true, chunks: phraseChunks, maxLines: 2, positionY: 68, fontSize: 32, grouping: 'phrase' },
  audio: { required: true, narration: true, sourceSpeech: false, music: true, musicVolume: 0.25 },
  target: { width: 1080, height: 1920, fps: 30 },
  ...over,
});

before(() => {
  // 1 & 12: High-quality 1080x1920 reel: 4 distinct 2s scenes, H.264 High / yuv420p, 30fps CFR,
  // 48kHz stereo AAC with strong speech-band (650Hz + 1100Hz) signal normalized to -14 LUFS, +faststart.
  const srcs = ['testsrc2', 'smptebars', 'rgbtestsrc', 'testsrc'];
  ff(
    ...srcs.flatMap((s) => ['-f', 'lavfi', '-i', `${s}=s=1080x1920:r=30:d=2`]),
    '-f', 'lavfi', '-i', 'aevalsrc=0.35*sin(2*PI*650*t)+0.25*sin(2*PI*1150*t):s=48000:c=stereo:d=8',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1,format=yuv420p[v];[4:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    f('good.mp4'),
  );

  // 4: Incorrect resolution (512x910 instead of 1080x1920), no faststart.
  ff('-i', f('good.mp4'), '-vf', 'scale=512:910', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', f('small.mp4'));

  // 2: Completely silent audio track (AAC stream exists, decoded signal is 0 / -inf dB).
  ff(
    '-i', f('good.mp4'),
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v', '-map', '1:a', '-shortest',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    f('silent.mp4'),
  );

  // 3: Missing audio stream completely (video-only MP4).
  ff('-i', f('good.mp4'), '-map', '0:v', '-an', '-c:v', 'copy', '-movflags', '+faststart', f('no_audio.mp4'));

  // 5 & 6a: Black frame gap + non-adjacent repeated shot.
  ff(
    '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=black:s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'smptebars=s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=f=650:d=8',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1,format=yuv420p[v]',
    '-map', '[v]', '-map', '4:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    f('defects.mp4'),
  );

  // 6b: Static / frozen single image for the entire 8s reel.
  ff(
    '-f', 'lavfi', '-i', 'color=c=0x1e293b:s=1080x1920:r=30:d=8',
    '-f', 'lavfi', '-i', 'sine=f=650:d=8',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart',
    f('static_frozen.mp4'),
  );

  // 11: Audio-video sync problem (8s video with only 4s audio -> 4s A/V drift).
  ff(
    '-i', f('good.mp4'),
    '-f', 'lavfi', '-i', 'sine=f=650:d=4',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    f('av_desync.mp4'),
  );

  // 10: Corrupted export file (truncated / non-media bytes).
  fs.writeFileSync(f('corrupted.mp4'), Buffer.from('ftypisom_corrupted_truncated_payload'));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('probe & weights', () => {
  test('7 dimension weights sum exactly to 100', () => {
    const th = loadThresholds();
    const sum = Object.values(th.weights).reduce((a, b) => a + b, 0);
    assert.equal(sum, 100);
    assert.deepEqual(th.weights, { audio: 15, export: 15, visual: 20, captions: 15, storytelling: 15, pacing: 10, technical: 10 });
  });

  test('measures dimensions, codec, pixel format, fps, audio RMS/peak/speech-band, sharpness, scene cuts and faststart', async () => {
    const m = await probeMedia(f('good.mp4'));
    assert.equal(m.video?.width, 1080);
    assert.equal(m.video?.height, 1920);
    assert.equal(m.video?.codec, 'h264');
    assert.equal(m.video?.pixFmt, 'yuv420p');
    assert.ok(Math.abs((m.video?.fps ?? 0) - 30) < 0.5);
    assert.equal(m.audio?.codec, 'aac');
    assert.equal(m.faststart, true);
    assert.equal(detectFaststart(f('small.mp4')), false);
    assert.ok(m.analysis.sceneCuts.length >= 3, `cuts ${m.analysis.sceneCuts}`);
    assert.equal(m.analysis.frameHashes.length, 8);
    assert.ok((m.analysis.rmsDb ?? -120) > -30, `rmsDb ${m.analysis.rmsDb}`);
    assert.ok((m.analysis.speechBandMeanDb ?? -120) > -40, `speechBandMeanDb ${m.analysis.speechBandMeanDb}`);
    assert.ok((m.analysis.sharpnessScore ?? 0) > 10, `sharpness ${m.analysis.sharpnessScore}`);
  });

  test('dHash is stable and hamming distance counts differing bits', () => {
    const flat = Buffer.alloc(72, 100);
    const ramp = Buffer.from(Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20));
    const [h1, h2] = dHashFrames(Buffer.concat([flat, ramp]));
    assert.equal(h1, '0000000000000000');
    assert.equal(h2, 'ffffffffffffffff');
    assert.equal(hamming(h1, h2), 64);
  });
});

describe('12-scenario real-video regression suite', () => {
  test('Scenario 1 & 12: Reel passing every critical quality gate achieves Excellent (90+) & Ready to publish', async () => {
    const e = evaluate(await probeMedia(f('good.mp4')), timeline());
    assert.equal(e.status, 'PASS', JSON.stringify(e.problems.map((p) => [p.id, p.severity, p.message])));
    assert.equal(e.classification, 'Excellent', `score=${e.score}, problems=${JSON.stringify(e.problems.map((p) => p.id))}`);
    assert.equal(e.action, 'Ready to publish');
    assert.equal(e.readyToPublish, true);
    assert.equal(e.criticalOverride, false);
    assert.ok(e.score >= 90, `expected score >= 90, got ${e.score}`);
    assert.equal(e.spec.meetsSpec, true);
    assert.equal(e.spec.label, '1080x1920');
    assert.equal(e.dimensions.length, 7);
    const audioDim = e.dimensions.find((d) => d.key === 'audio')!;
    assert.equal(audioDim.checks.filter((c) => !c.passed).length, 0);
  });

  test('Scenario 2: Completely silent audio (stream present, 0 signal) triggers CRITICAL failure & Poor/REJECTED', async () => {
    const m = await probeMedia(f('silent.mp4'));
    assert.ok(m.audio !== null, 'audio stream exists in container');
    const e = evaluate(m, timeline());
    assert.equal(e.status, 'REJECTED');
    assert.equal(e.classification, 'Poor');
    assert.equal(e.action, 'Regeneration required');
    assert.equal(e.readyToPublish, false);
    assert.equal(e.criticalOverride, true);
    assert.ok(e.criticalDefects.some((c) => c.id === 'audio_present'));
    assert.ok(e.recommendations.some((r) => r.repairAction === 'regenerate_voiceover'));
  });

  test('Scenario 3: Missing audio stream triggers CRITICAL failure & Poor/REJECTED', async () => {
    const m = await probeMedia(f('no_audio.mp4'));
    assert.equal(m.audio, null);
    const e = evaluate(m, timeline());
    assert.equal(e.status, 'REJECTED');
    assert.equal(e.classification, 'Poor');
    assert.equal(e.criticalOverride, true);
    assert.ok(e.criticalDefects.some((c) => c.id === 'audio_present'));
  });

  test('Scenario 4: Incorrect resolution (512x910 vs 1080x1920) triggers CRITICAL failure, never upscaled', async () => {
    const e = evaluate(await probeMedia(f('small.mp4')), timeline());
    assert.equal(e.status, 'REJECTED');
    assert.equal(e.classification, 'Poor');
    assert.equal(e.readyToPublish, false);
    assert.ok(e.criticalDefects.some((c) => c.id === 'dimensions'));
    assert.equal(e.spec.meetsSpec, false);
    assert.equal(e.spec.label, '512x910');
    assert.deepEqual(e.spec.actual && [e.spec.actual.width, e.spec.actual.height], [512, 910]);
    const render = e.dimensions.find((d) => d.key === 'visual')!.checks.find((c) => c.id === 'render_resolution')!;
    assert.equal(render.passed, false);
  });

  test('Scenario 5: Black frames detected with evidence on FFmpeg 4.4+', async () => {
    const m = await probeMedia(f('defects.mp4'));
    const e = evaluate(m, null);
    const ids = e.problems.map((p) => p.id);
    assert.ok(ids.includes('black_frames'), ids.join());
    assert.ok(ids.includes('continuity'), ids.join());
    assert.ok(ids.includes('repeated_shots'), ids.join());
    const rep = e.problems.find((p) => p.id === 'repeated_shots')!;
    assert.ok(Array.isArray((rep.evidence as any).repeats) && (rep.evidence as any).repeats.length >= 1);
  });

  test('Scenario 6: Repeated static footage / frozen video is detected by frozen_video, scene_diversity, asset_reuse & shot_length', async () => {
    const m = await probeMedia(f('static_frozen.mp4'));
    const staticTimeline = timeline({
      beats: [
        { text: 'One static shot lasts way too long.', start_s: 0, end_s: 8, asset: 'same-clip', kind: 'broll', visual_keywords: 'static' },
      ],
      durationS: 8,
      scriptText: 'One static shot lasts way too long.',
    });
    const e = evaluate(m, staticTimeline);
    const ids = e.problems.map((p) => p.id);
    assert.ok(ids.includes('frozen_video'), `expected frozen_video in ${ids.join(',')}`);
    assert.ok(ids.includes('scene_diversity'), `expected scene_diversity in ${ids.join(',')}`);
    assert.ok(ids.includes('shot_length'), `expected shot_length in ${ids.join(',')}`);
    assert.notEqual(e.classification, 'Excellent');

    // Also verify timeline asset_reuse check
    const reuseT = timeline({
      beats: [
        { text: 'One.', start_s: 0, end_s: 9, asset: 'x', kind: 'broll' },
        { text: 'Two.', start_s: 9, end_s: 11, asset: 'y', kind: 'broll' },
        { text: 'Three.', start_s: 11, end_s: 13, asset: 'x', kind: 'broll' },
      ],
      durationS: 13,
      scriptText: 'One. Two. Three.',
    });
    const reuseIds = evaluate(null, reuseT).problems.map((p) => p.id);
    assert.ok(reuseIds.includes('asset_reuse') && reuseIds.includes('shot_length'));
  });

  test('Scenario 7: Incorrect caption timestamps (overlaps, out-of-range, word sync, speech onset desync) are caught', () => {
    const th = loadThresholds();
    const chunks = [
      {
        text: 'Why does your to-do list never get done?',
        start_s: 0,
        end_s: 3,
        words: 8,
        wordTimings: [
          { word: 'Why', start_s: 2.0, end_s: 2.5 },
          { word: 'does', start_s: 1.0, end_s: 1.4 }, // non-monotonic!
        ],
      },
      { text: 'Pick one task every morning.', start_s: 2, end_s: 4, words: 5 },
      { text: 'Do it first.', start_s: 7, end_s: 12, words: 3 },
    ];
    const r = evaluateCaptions(null, timeline({ captions: { enabled: true, chunks } }), th);
    const failed = Object.fromEntries(r.filter((c) => !c.passed).map((c) => [c.id, c]));
    assert.ok(failed.coverage && (failed.coverage.evidence as any).missing.includes('lazy'));
    assert.ok(failed.overlaps);
    assert.ok(failed.timing_range);
    assert.ok(failed.word_timing_sync);

    // Speech onset desync
    const media = { audio: { codec: 'aac', sampleRate: 48000, channels: 2, durationS: 8 }, analysis: { silenceSegments: [{ start: 0, end: 2 }] } } as unknown as MediaFacts;
    const syncRes = evaluateCaptions(media, timeline({ audio: { required: true, narration: true, sourceSpeech: false, music: false } }), th);
    assert.equal(syncRes.find((c) => c.id === 'sync_start')!.passed, false);
  });

  test('Scenario 8: Overflowing subtitles (> 2 lines) and unsafe caption positionY are flagged', () => {
    const th = loadThresholds();
    const overflowingChunks = phraseChunks.map((c) => ({ ...c, lines: 4 }));
    const t = timeline({
      captions: { enabled: true, chunks: overflowingChunks, maxLines: 2, positionY: 92 },
    });
    const r = evaluateCaptions(null, t, th);
    assert.equal(r.find((c) => c.id === 'overflow')!.passed, false);
    assert.equal(r.find((c) => c.id === 'safe_positioning')!.passed, false);
  });

  test('Scenario 9: Missing scenes / incomplete narrative structure is flagged in Storytelling', () => {
    const emptyScenes = timeline({ beats: [], scriptText: '' });
    const e = evaluate(null, emptyScenes);
    const story = e.dimensions.find((d) => d.key === 'storytelling')!;
    assert.ok(story.checks.some((c) => c.id === 'missing_scenes' && !c.passed));
  });

  test('Scenario 10: Corrupted export file fails probe & triggers CRITICAL file_readable rejection', async () => {
    await assert.rejects(() => probeMedia(f('corrupted.mp4')));
    const e = evaluate(null, timeline());
    assert.equal(e.status, 'REJECTED');
    assert.equal(e.classification, 'Poor');
    assert.equal(e.criticalOverride, true);
    assert.ok(e.criticalDefects.some((c) => c.id === 'file_readable'));
  });

  test('Scenario 11: Audio-video synchronization problems (duration drift & stream start PTS offset) are detected', async () => {
    const m = await probeMedia(f('av_desync.mp4'));
    const e = evaluate(m, timeline());
    const ids = e.problems.map((p) => p.id);
    assert.ok(ids.includes('av_alignment'), `expected av_alignment in ${ids.join(',')}`);

    // Stream start PTS offset check
    const shifted: MediaFacts = {
      ...m,
      video: { ...m.video!, startTimeS: 0 },
      audio: { ...m.audio!, startTimeS: 0.75 },
    };
    const e2 = evaluate(shifted, timeline());
    assert.ok(e2.problems.some((p) => p.id === 'stream_timestamps'));
  });
});

describe('caption helpers & preflight', () => {
  const th = loadThresholds();
  test('missingWords is order-aware and reports exactly the dropped words', () => {
    assert.deepEqual(missingWords(tokens('a b c d e'), tokens('a c e')), ['b', 'd']);
    assert.deepEqual(missingWords(tokens('one two'), tokens('one two')), []);
  });

  test('repeatedShots ignores adjacent continuation but flags a non-adjacent repeat', () => {
    const a = '0f0f0f0f0f0f0f0f';
    const b = 'f0f0f0f0f0f0f0f0';
    const shots = segmentShots(8, [2, 4, 6], [a, a, a, b, b, b, a, a]);
    assert.equal(shots.length, 4);
    assert.deepEqual(repeatedShots(shots).map((r) => [r.index, r.repeats]), [[3, 0]]);
  });

  test('critical failure override rejects reel even when all other dimensions are perfect', async () => {
    const m = await probeMedia(f('good.mp4'));
    const t = timeline({ captions: { enabled: true, chunks: [{ text: 'Why does', start_s: 0, end_s: 1, words: 2 }] } });
    const e = evaluate(m, t);
    assert.equal(e.status, 'REJECTED');
    assert.equal(e.classification, 'Poor');
    assert.equal(e.criticalOverride, true);
    assert.ok(e.criticalDefects.some((c) => c.id === 'coverage'));
  });

  test('2-word fragments trigger major defect and Needs improvement classification', async () => {
    const m = await probeMedia(f('good.mp4'));
    const words = SCRIPT.split(' ');
    const pairs = [];
    for (let i = 0; i < words.length; i += 2) {
      pairs.push({
        text: words.slice(i, i + 2).join(' '),
        start_s: (i / words.length) * 7.8,
        end_s: ((i + 2) / words.length) * 7.8 - 0.01,
        words: Math.min(2, words.length - i),
        lines: 1,
      });
    }
    const t = timeline({ captions: { enabled: true, chunks: pairs } });
    const strict = evaluate(m, t, th);
    assert.ok(strict.problems.some((p) => p.id === 'fragments' && p.severity === 'major'));
    assert.equal(strict.status, 'NEEDS_IMPROVEMENT');
    assert.equal(strict.classification, 'Needs improvement');
    assert.ok(strict.recommendations.some((r) => r.repairAction === 'enable_phrase_captions'));
  });

  test('preflight evaluates timeline honestly without fabricating media measurements', () => {
    const pre = evaluatePreflight(timeline());
    assert.equal(pre.dimensions.length, 7);
    assert.equal(pre.spec.actual, null);
    assert.ok(pre.score >= 85, `expected high preflight score, got ${pre.score}`);
    const noAudioPre = evaluatePreflight(timeline({ audio: { required: true, narration: false, sourceSpeech: false, music: false } }));
    assert.equal(noAudioPre.status, 'REJECTED');
    assert.equal(noAudioPre.criticalOverride, true);
  });
});
