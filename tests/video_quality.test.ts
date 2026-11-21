// Unit tests for the video quality engine (server/lib/videoQuality). Media fixtures are generated with ffmpeg so each
// defect is known exactly; nothing here hard-codes an expected total score.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeMedia, detectFaststart, dHashFrames } from '../server/lib/videoQuality/probe.ts';
import { evaluate, loadThresholds } from '../server/lib/videoQuality/evaluator.ts';
import { evaluateCaptions, missingWords, tokens } from '../server/lib/videoQuality/captionQuality.ts';
import { hamming, repeatedShots, segmentShots } from '../server/lib/videoQuality/similarity.ts';
import type { MediaFacts, Timeline } from '../server/lib/videoQuality/models.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-'));
const f = (n: string) => path.join(tmp, n);
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);

const SCRIPT = 'Why does your to-do list never get done? It is not because you are lazy. Pick one task every morning. Do it first.';
const BEATS = [
  { text: 'Why does your to-do list never get done?', start_s: 0, end_s: 2.5 },
  { text: 'It is not because you are lazy.', start_s: 2.5, end_s: 4.5 },
  { text: 'Pick one task every morning.', start_s: 4.5, end_s: 6.5 },
  { text: 'Do it first.', start_s: 6.5, end_s: 8 },
];
const phraseChunks = BEATS.map((b) => ({ text: b.text, start_s: b.start_s + 0.05, end_s: b.end_s - 0.05, words: b.text.split(' ').length, lines: 2 }));
const timeline = (over: Partial<Timeline> = {}): Timeline => ({
  durationS: 8,
  scriptText: SCRIPT,
  beats: BEATS.map((b, i) => ({ ...b, asset: `clip-${i}`, kind: 'broll' as const, visual_keywords: ['list task', 'lazy person', 'morning task', 'first task'][i] })),
  captions: { enabled: true, chunks: phraseChunks, maxLines: 2 },
  audio: { required: true, narration: false, sourceSpeech: false, music: true, musicVolume: 0.3 },
  target: { width: 1080, height: 1920, fps: 30 },
  ...over,
});

before(() => {
  // Good: four distinct 2 s shots at 1080x1920 30 fps, H.264/yuv420p, AAC, faststart.
  const srcs = ['testsrc2', 'smptebars', 'rgbtestsrc', 'testsrc'];
  ff(...srcs.flatMap((s) => ['-f', 'lavfi', '-i', `${s}=s=1080x1920:r=30:d=2`]), '-f', 'lavfi', '-i', 'sine=f=440:d=8,volume=0.5',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1,format=yuv420p[v];[4:a]loudnorm=I=-14[a]', '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', f('good.mp4'));
  // Reference-like defect: correct content, but the encoder delivered 512x910.
  ff('-i', f('good.mp4'), '-vf', 'scale=512:910', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', f('small.mp4'));
  // Silent audio track.
  ff('-i', f('good.mp4'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'copy', '-c:a', 'aac', f('silent.mp4'));
  // Black gap + repeated first shot.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'color=black:s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'smptebars=s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1,format=yuv420p[v]', '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', f('defects.mp4'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('probe', () => {
  test('measures dimensions, codec, pixel format, fps, audio and faststart from the file', async () => {
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

describe('export integrity', () => {
  test('a 512x910 file is never accepted as 1080x1920: critical dimensions defect, REJECTED, honest label', async () => {
    const e = evaluate(await probeMedia(f('small.mp4')), timeline());
    assert.equal(e.status, 'REJECTED');
    assert.ok(e.criticalDefects.some((c) => c.id === 'dimensions'));
    assert.equal(e.spec.meetsSpec, false);
    assert.equal(e.spec.label, '512x910');
    assert.deepEqual(e.spec.actual && [e.spec.actual.width, e.spec.actual.height], [512, 910]);
    const render = e.dimensions.find((d) => d.key === 'visual')!.checks.find((c) => c.id === 'render_resolution')!;
    assert.equal(render.passed, false, 'render resolution is reported separately from the export size');
  });
  test('a well-formed reel meets the export spec', async () => {
    const e = evaluate(await probeMedia(f('good.mp4')), timeline());
    const exp = e.dimensions.find((d) => d.key === 'export')!;
    assert.deepEqual(exp.checks.filter((c) => !c.passed).map((c) => c.id), []);
    assert.equal(e.spec.meetsSpec, true);
    assert.equal(e.spec.label, '1080x1920');
    assert.notEqual(e.status, 'REJECTED', JSON.stringify(e.problems.map((p) => p.id)));
  });
  test('a missing file / unreadable media is critical', () => {
    const e = evaluate(null, timeline());
    assert.equal(e.status, 'REJECTED');
    assert.ok(e.criticalDefects.some((c) => c.id === 'file_readable'));
  });
});

describe('audio', () => {
  test('silent audio when audio is required is a critical defect', async () => {
    const e = evaluate(await probeMedia(f('silent.mp4')), timeline());
    assert.equal(e.status, 'REJECTED');
    assert.ok(e.criticalDefects.some((c) => c.id === 'audio_signal'));
    assert.equal(e.classification, 'POOR');
    assert.ok((e.criticalDefects.find((c) => c.id === 'audio_signal')!.evidence as any).digitalSilence, 'decoded samples are all zero');
  });
});

describe('visual + diversity', () => {
  test('black gap, freeze and a repeated shot are detected with evidence', async () => {
    const m = await probeMedia(f('defects.mp4'));
    const e = evaluate(m, null);
    const ids = e.problems.map((p) => p.id);
    assert.ok(ids.includes('black_frames'), ids.join());
    assert.ok(ids.includes('continuity'), ids.join());
    assert.ok(ids.includes('repeated_shots'), ids.join());
    const rep = e.problems.find((p) => p.id === 'repeated_shots')!;
    assert.ok(Array.isArray((rep.evidence as any).repeats) && (rep.evidence as any).repeats.length >= 1);
  });
  test('repeatedShots ignores adjacent continuation but flags a non-adjacent repeat', () => {
    const a = '0f0f0f0f0f0f0f0f';
    const b = 'f0f0f0f0f0f0f0f0';
    const shots = segmentShots(8, [2, 4, 6], [a, a, a, b, b, b, a, a]);
    assert.equal(shots.length, 4);
    assert.deepEqual(repeatedShots(shots).map((r) => [r.index, r.repeats]), [[3, 0]]);
  });
  test('the same media reused across scenes and an over-long shot are flagged from the timeline', () => {
    const t = timeline({ beats: [{ text: 'One.', start_s: 0, end_s: 9, asset: 'x', kind: 'broll' }, { text: 'Two.', start_s: 9, end_s: 11, asset: 'y', kind: 'broll' }, { text: 'Three.', start_s: 11, end_s: 13, asset: 'x', kind: 'broll' }], durationS: 13, scriptText: 'One. Two. Three.' });
    const e = evaluate(null, t);
    const ids = e.problems.map((p) => p.id);
    assert.ok(ids.includes('asset_reuse') && ids.includes('shot_length'), ids.join());
  });
});

describe('captions', () => {
  const th = loadThresholds();
  test('missingWords is order-aware and reports exactly the dropped words', () => {
    assert.deepEqual(missingWords(tokens('a b c d e'), tokens('a c e')), ['b', 'd']);
    assert.deepEqual(missingWords(tokens('one two'), tokens('one two')), []);
  });
  test('complete phrase captions pass; 2-word fragments are flagged', () => {
    const good = evaluateCaptions(null, timeline(), th);
    assert.deepEqual(good.filter((c) => !c.passed).map((c) => c.id), []);
    const words = SCRIPT.split(' ');
    const pairs = [];
    for (let i = 0; i < words.length; i += 2) pairs.push({ text: words.slice(i, i + 2).join(' '), start_s: i * 0.35, end_s: i * 0.35 + 0.6, words: Math.min(2, words.length - i) });
    const frag = evaluateCaptions(null, timeline({ captions: { enabled: true, chunks: pairs } }), th);
    assert.equal(frag.find((c) => c.id === 'fragments')!.passed, false);
  });
  test('dropped words, overlaps and out-of-range captions are detected', () => {
    const chunks = [
      { text: 'Why does your to-do list never get done?', start_s: 0, end_s: 3, words: 8 },
      { text: 'Pick one task every morning.', start_s: 2, end_s: 4, words: 5 },
      { text: 'Do it first.', start_s: 7, end_s: 12, words: 3 },
    ];
    const r = evaluateCaptions(null, timeline({ captions: { enabled: true, chunks } }), th);
    const failed = Object.fromEntries(r.filter((c) => !c.passed).map((c) => [c.id, c]));
    assert.ok(failed.coverage && (failed.coverage.evidence as any).missing.includes('lazy'));
    assert.ok(failed.overlaps);
    assert.ok(failed.timing_range);
  });
  test('sync: captions must start with the speech in the exported audio', () => {
    const media = {
      audio: { codec: 'aac', sampleRate: 48000, channels: 2, durationS: 8 },
      analysis: { silenceSegments: [{ start: 0, end: 2 }], audioSignal: { digitalSilence: false, speechSpans: [{ start: 2, end: 8 }], activeSpans: [{ start: 2, end: 8 }] } },
    } as unknown as MediaFacts;
    const t = timeline({ audio: { required: true, narration: true, sourceSpeech: false, music: false } });
    const r = evaluateCaptions(media, t, th);
    assert.equal(r.find((c) => c.id === 'sync_start')!.passed, false);
  });
});

describe('quality gate', () => {
  test('broken captions reject the reel even when everything else is excellent', async () => {
    const m = await probeMedia(f('good.mp4'));
    const t = timeline({ captions: { enabled: true, chunks: [{ text: 'Why does', start_s: 0, end_s: 1, words: 2 }] } });
    const e = evaluate(m, t);
    assert.equal(e.status, 'REJECTED');
    assert.ok(e.criticalDefects.some((c) => c.id === 'coverage'));
  });
  test('thresholds are configurable', async () => {
    const m = await probeMedia(f('good.mp4'));
    const strict = evaluate(m, timeline(), loadThresholds({ QUALITY_PASS_SCORE: '101', QUALITY_IMPROVE_SCORE: '100.5' } as any));
    assert.equal(strict.status, 'REJECTED');
    const smallOk = evaluate(await probeMedia(f('small.mp4')), timeline({ target: { width: 512, height: 910, fps: 30 } }));
    assert.ok(!smallOk.criticalDefects.some((c) => c.id === 'dimensions'), 'a 512x910 target is honoured when configured');
  });
  test('every check carries evidence; unmeasurable dimensions are reported, not guessed', async () => {
    const e = evaluate(await probeMedia(f('good.mp4')), null);
    for (const d of e.dimensions) for (const c of d.checks) assert.ok(c.evidence && typeof c.evidence === 'object', `${c.id} has evidence`);
    assert.ok(e.notes.some((n) => /could not be measured/.test(n)));
  });
});

describe('quality gate: majors', () => {
  test('a high score with a major defect is NEEDS_IMPROVEMENT, not PASS (unless explicitly allowed)', async () => {
    const m = await probeMedia(f('good.mp4'));
    const words = SCRIPT.split(' ');
    const pairs = [];
    for (let i = 0; i < words.length; i += 2) pairs.push({ text: words.slice(i, i + 2).join(' '), start_s: (i / words.length) * 7.8, end_s: ((i + 2) / words.length) * 7.8 - 0.01, words: Math.min(2, words.length - i), lines: 1 });
    const t = timeline({ captions: { enabled: true, chunks: pairs } });
    const strict = evaluate(m, t);
    assert.ok(strict.problems.some((p) => p.id === 'fragments' && p.severity === 'major'), JSON.stringify(strict.problems.map((p) => [p.id, p.severity])));
    assert.equal(strict.status, 'NEEDS_IMPROVEMENT');
    assert.ok(strict.suggestions.some((s) => /phrase captions/i.test(s)));
    const relaxed = evaluate(m, t, loadThresholds({ QUALITY_PASS_ALLOW_MAJOR: 'true' } as any));
    assert.equal(relaxed.score, strict.score);
  });
});
