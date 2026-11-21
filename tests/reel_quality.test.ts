// Regression suite for the Forge Reel Quality Evaluation Engine (server/lib/videoQuality).
// Every scenario runs against a REAL rendered file: video from ffmpeg sources, speech synthesised with ffmpeg's flite
// voice, captions aligned to that speech. Nothing mocks ffprobe/ffmpeg output, and no test asserts a hard-coded total
// score: tests assert the classification, the critical overrides and the evidence of the specific defect.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { probeMedia, effectiveDetail } from '../server/lib/videoQuality/probe.ts';
import { evaluate, classify, loadThresholds } from '../server/lib/videoQuality/evaluator.ts';
import { analyzeSpeech, s16leToFloat } from '../server/lib/videoQuality/speech.ts';
import { speechOffset } from '../server/lib/videoQuality/technicalQuality.ts';
import { parseReview, reviewChecks, runAiReview } from '../server/lib/videoQuality/aiReview.ts';
import { proposeHook } from '../server/lib/videoQuality/repairs.ts';
import { alignWordsToAudio } from '../src/utils/alignment.ts';
import type { MediaFacts, Timeline } from '../server/lib/videoQuality/models.ts';

const hasFlite = /\bflite\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');
const skip = hasFlite ? false : 'ffmpeg without libflite (needed to synthesise real speech fixtures)';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelq-'));
const f = (n: string) => path.join(tmp, n);
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);
const SR = 16000;

// A small, well-formed Short: hook question → context → main → CTA.
const LINES = [
  'Why do most people never finish their to do list?',
  'It is not laziness, it is too many choices.',
  'Pick one task tonight and do it first tomorrow.',
  'Follow for one simple habit every day.',
];
const KEYWORDS = ['to do list notebook', 'choices menu', 'task morning desk', 'habit calendar'];
const SOURCES = ['testsrc2', 'testsrc', 'mandelbrot', 'cellauto'];

let lineSpans: Array<{ start: number; end: number }> = [];
let words: Array<{ word: string; start_s: number; end_s: number }> = [];
let DUR = 0;

function pcmOf(file: string): Float32Array {
  return s16leToFloat(execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 1 << 28 }));
}

type Over = Omit<Partial<Timeline>, 'audio' | 'captions'> & { audio?: Partial<Timeline['audio']>; captions?: Partial<Timeline['captions']> };
const timeline = (over: Over = {}): Timeline => {
  // Phrase captions = one per line, timed to the aligned words of that line.
  const chunks = LINES.map((l, i) => {
    const ws = words.filter((w) => w.start_s >= lineSpans[i].start - 0.05 && w.start_s < lineSpans[i].end);
    return { text: l, start_s: ws[0].start_s, end_s: ws[ws.length - 1].end_s, words: ws.length, lines: 2 };
  });
  const base: Timeline = {
    durationS: DUR,
    scriptText: LINES.join(' '),
    beats: LINES.map((text, i) => ({
      text,
      start_s: i * (DUR / 4),
      end_s: (i + 1) * (DUR / 4),
      visual_keywords: KEYWORDS[i],
      asset: `stock:${SOURCES[i]}`,
      kind: 'broll' as const,
      role: (['hook', 'context', 'main', 'cta'] as const)[i],
    })),
    captions: { enabled: true, chunks, maxLines: 2, wordTiming: 'aligned', words: words.map((w) => ({ start_s: w.start_s, end_s: w.end_s })), box: { top: 0.58, bottom: 0.7, left: 0.08, right: 0.92 }, subjectOverlap: 0 },
    audio: { required: true, narration: true, sourceSpeech: false, music: false, speechExpected: true, speechSource: 'offline-tts' },
    target: { width: 1080, height: 1920, fps: 30 },
  };
  return { ...base, ...over, audio: { ...base.audio, ...(over.audio || {}) }, captions: { ...base.captions, ...(over.captions || {}) } } as Timeline;
};

const ids = (e: { problems: Array<{ id: string }> }) => e.problems.map((p) => p.id);
const crit = (e: { criticalDefects: Array<{ id: string }> }) => e.criticalDefects.map((p) => p.id);
const probe = (n: string) => probeMedia(f(n));

before(() => {
  if (skip) return;
  // 1. Real speech: each line synthesised, joined with natural pauses; line spans known exactly.
  const parts: string[] = [];
  let t = 0.25;
  const lead = f('lead.wav');
  ff('-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=mono`, '-t', '0.25', lead);
  parts.push(lead);
  LINES.forEach((l, i) => {
    const txt = f(`l${i}.txt`);
    fs.writeFileSync(txt, l);
    const w = f(`l${i}.wav`);
    ff('-f', 'lavfi', '-i', `flite=textfile='${txt}':voice=slt`, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB', '-ar', String(SR), '-ac', '1', w);
    const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', w]).toString());
    lineSpans.push({ start: t, end: t + d });
    parts.push(w);
    t += d;
    const gap = f(`g${i}.wav`);
    ff('-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=mono`, '-t', '0.35', gap);
    parts.push(gap);
    t += 0.35;
  });
  fs.writeFileSync(f('list.txt'), parts.map((p) => `file '${p}'`).join('\n'));
  ff('-f', 'concat', '-safe', '0', '-i', f('list.txt'), '-ar', '48000', '-ac', '2', f('voice.wav'));
  DUR = Math.round(t * 100) / 100;
  // Captions: words aligned to the real voice, line by line (the same aligner the editor uses).
  const pcm = pcmOf(f('voice.wav'));
  LINES.forEach((l, i) => {
    const s = Math.floor(lineSpans[i].start * SR);
    const e = Math.ceil(lineSpans[i].end * SR);
    const al = alignWordsToAudio(pcm.subarray(s, e), SR, l.split(' '));
    al.words.forEach((w) => words.push({ word: w.word, start_s: lineSpans[i].start + w.start_s, end_s: lineSpans[i].start + w.end_s }));
  });
  // 2. Picture: four distinct scenes, 1080x1920, 30 fps.
  const seg = DUR / 4;
  const vin = SOURCES.flatMap((s) => ['-f', 'lavfi', '-i', `${s}=s=1080x1920:r=30`]);
  const trims = SOURCES.map((_, i) => `[${i}:v]trim=0:${seg.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`).join(';');
  ff(...vin, '-filter_complex', `${trims};[v0][v1][v2][v3]concat=n=4:v=1[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('picture.mp4'));
  const mux = (video: string, audio: string, out: string, extra: string[] = []) =>
    ff('-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', ...extra, '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-af', 'loudnorm=I=-14:TP=-1.5', '-shortest', '-movflags', '+faststart', out);
  mux(f('picture.mp4'), f('voice.wav'), f('good.mp4'));
  // Silent audio track (an AAC stream of digital zeros, exactly what the failed reel carried).
  ff('-i', f('picture.mp4'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', f('silent.mp4'));
  // No audio stream at all.
  ff('-i', f('good.mp4'), '-an', '-c:v', 'copy', '-movflags', '+faststart', f('noaudio.mp4'));
  // Wrong resolution: the encoder delivered 512x910.
  ff('-i', f('good.mp4'), '-vf', 'scale=512:910', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', '-movflags', '+faststart', f('small.mp4'));
  // Black frames: scene 2 replaced by black.
  const vin2 = ['testsrc2=', 'color=c=black:', 'mandelbrot=', 'cellauto='].flatMap((s) => ['-f', 'lavfi', '-i', `${s}s=1080x1920:r=30`]);
  ff(...vin2, '-filter_complex', `${trims};[v0][v1][v2][v3]concat=n=4:v=1[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('pic_black.mp4'));
  mux(f('pic_black.mp4'), f('voice.wav'), f('black.mp4'));
  // Repeated static footage: ONE small still (270x480) stretched to 1080x1920 with a slow zoom for the whole reel.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=270x480:d=1', '-frames:v', '1', f('still.png'));
  ff('-loop', '1', '-i', f('still.png'), '-vf', `scale=1080:1920:flags=bicubic,zoompan=z='min(1.08,1+0.0003*on)':d=1:s=1080x1920:fps=30,format=yuv420p`, '-t', String(DUR), '-c:v', 'libx264', '-preset', 'ultrafast', f('pic_static.mp4'));
  mux(f('pic_static.mp4'), f('voice.wav'), f('static.mp4'));
  // A/V desync: the voice arrives 1.5 s late (delay inside the audio stream).
  ff('-i', f('picture.mp4'), '-i', f('voice.wav'), '-map', '0:v', '-map', '1:a', '-af', 'adelay=1500|1500,loudnorm=I=-14:TP=-1.5', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-t', String(DUR), '-movflags', '+faststart', f('desync.mp4'));
  // Corrupted export: a truncated recording (no index) and plain garbage.
  const good = fs.readFileSync(f('good.mp4'));
  fs.writeFileSync(f('truncated.mp4'), good.subarray(0, Math.floor(good.length * 0.3))); // header intact, data cut off
  fs.writeFileSync(f('garbage.mp4'), Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 7919) % 251)));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('reel quality: the 12 regression scenarios (real rendered files)', { skip }, () => {
  test('1. valid audio: real speech is detected, covers the captions, and is in sync', async () => {
    const m = await probe('good.mp4');
    const e = evaluate(m, timeline());
    const audio = e.dimensions.find((d) => d.key === 'audio')!;
    const byId = Object.fromEntries(audio.checks.map((c) => [c.id, c]));
    assert.equal(byId.audio_signal.passed, true);
    assert.equal(byId.speech_presence.passed, true, byId.speech_presence.message);
    assert.equal(byId.voiceover_completeness.passed, true, byId.voiceover_completeness.message);
    assert.ok(m.analysis.audioSignal!.speechRatio > 0.4, `speech ratio ${m.analysis.audioSignal!.speechRatio}`);
    assert.equal(e.dimensions.find((d) => d.key === 'technical')!.checks.find((c) => c.id === 'av_sync')!.passed, true);
  });

  test('2. completely silent audio stream: critical, POOR, whatever else scores', async () => {
    const m = await probe('silent.mp4');
    assert.ok(m.audio, 'the file HAS an audio stream');
    const e = evaluate(m, timeline());
    assert.ok(crit(e).includes('audio_signal'), crit(e).join());
    assert.equal((e.criticalDefects.find((c) => c.id === 'audio_signal')!.evidence as any).digitalSilence, true);
    assert.equal(e.classification, 'POOR');
    assert.equal(e.action, 'Regeneration required');
    assert.equal(e.readyToPublish, false);
    assert.ok(e.recommendations.some((r) => r.action === 'regenerate_voiceover' && r.priority === 'critical'));
    // Silence fails even when the client claims no audio was "required" (the failed reel's situation)...
    assert.ok(crit(evaluate(m, timeline({ audio: { required: false, narration: false, speechExpected: false, speechSource: 'none' } }))).includes('audio_signal'));
    // ...and is only exempt when the creator explicitly asked for a silent reel.
    assert.ok(!crit(evaluate(m, timeline({ audio: { silentIntended: true, speechExpected: false, narration: false, speechSource: 'none' } }))).includes('audio_signal'));
  });

  test('3. missing audio stream: critical', async () => {
    const e = evaluate(await probe('noaudio.mp4'), timeline());
    assert.ok(crit(e).includes('audio_stream'), crit(e).join());
    assert.equal(e.classification, 'POOR');
  });

  test('4. incorrect resolution (512x910 for a 1080x1920 export): critical, honest label, never upscaled', async () => {
    const e = evaluate(await probe('small.mp4'), timeline());
    assert.ok(crit(e).includes('dimensions'), crit(e).join());
    assert.equal(e.spec.label, '512x910');
    assert.ok(ids(e).includes('render_resolution'));
    assert.ok(e.recommendations.some((r) => r.action === 'rerender_resolution'));
  });

  test('5. black frames: detected with timestamps, and the black gap breaks continuity', async () => {
    const e = evaluate(await probe('black.mp4'), timeline());
    const black = e.problems.find((p) => p.id === 'black_frames');
    assert.ok(black, ids(e).join());
    const seg = (black!.evidence as any).segments[0];
    assert.ok(Math.abs(seg.start - DUR / 4) < 0.5, `black starts at ${seg.start}`);
    assert.ok(ids(e).includes('continuity'));
  });

  test('6. repeated static footage: one upscaled still with a slow zoom is ONE picture, not 30 distinct frames', async () => {
    const m = await probe('static.mp4');
    const e = evaluate(m, timeline({ beats: timeline().beats.map((b) => ({ ...b, asset: 'thumb.jpg', kind: 'image' as const })) }));
    for (const id of ['static_visuals', 'scene_diversity', 'visual_progression', 'effective_detail']) assert.ok(ids(e).includes(id), `${id} in ${ids(e).join()}`);
    assert.equal(m.analysis.stability!.distinctVisuals, 1);
    assert.ok(m.analysis.detail!.effectiveFactor >= 3, `effective factor ${m.analysis.detail!.effectiveFactor}`);
    assert.ok(['NEEDS_IMPROVEMENT', 'POOR'].includes(e.classification), e.classification);
    assert.ok(e.recommendations.some((r) => r.action === 'replace_scenes'));
    // The four-scene reel is not flagged.
    const ok = evaluate(await probe('good.mp4'), timeline());
    assert.ok(!ids(ok).includes('static_visuals') && !ids(ok).includes('scene_diversity'), ids(ok).join());
  });

  test('7. incorrect caption timestamps: captions 2.5 s late are caught against the measured speech', async () => {
    const t = timeline();
    const late = timeline({ captions: { ...t.captions, chunks: t.captions.chunks.map((c) => ({ ...c, start_s: c.start_s + 2.5, end_s: c.end_s + 2.5 })) } });
    const e = evaluate(await probe('good.mp4'), late);
    assert.ok(ids(e).includes('sync_start'), ids(e).join());
    assert.ok(e.criticalDefects.length > 0, 'a 2.5 s caption offset is a critical sync failure');
    assert.ok(e.recommendations.some((r) => r.action === 'realign_captions'));
    // Overlapping / out-of-range caption times are caught without media too.
    const broken = timeline({ captions: { ...t.captions, chunks: [{ ...t.captions.chunks[0], end_s: t.captions.chunks[1].start_s + 1 }, ...t.captions.chunks.slice(1), { text: 'x', start_s: DUR + 3, end_s: DUR + 4, words: 1 }] } });
    const p = evaluate(null, broken, loadThresholds(), { mode: 'plan' });
    assert.ok(ids(p).includes('overlaps') && ids(p).includes('timing_range'), ids(p).join());
  });

  test('8. overflowing subtitles: too many lines and a box under the Shorts UI are flagged', async () => {
    const t = timeline();
    const e = evaluate(await probe('good.mp4'), timeline({
      captions: { ...t.captions, chunks: t.captions.chunks.map((c) => ({ ...c, lines: 4 })), box: { top: 0.84, bottom: 0.97, left: 0.01, right: 0.99 } },
    }));
    assert.ok(ids(e).includes('overflow'), ids(e).join());
    assert.ok(ids(e).includes('safe_area'), ids(e).join());
    assert.ok(e.recommendations.some((r) => r.action === 'regroup_captions'));
    assert.ok(e.recommendations.some((r) => r.action === 'reposition_captions'));
  });

  test('9. missing scenes: planned scenes that were never rendered are a critical failure', async () => {
    const t = timeline();
    const beats = t.beats.map((b, i) => (i === 1 || i === 2 ? { ...b, asset: undefined } : b));
    const e = evaluate(await probe('good.mp4'), timeline({ beats }));
    assert.ok(crit(e).includes('scenes_rendered'), crit(e).join());
    const ev = e.criticalDefects.find((c) => c.id === 'scenes_rendered')!.evidence as any;
    assert.deepEqual(ev.missing.map((m: any) => m.scene), [2, 3]);
    // A gap in the scene plan is also caught before rendering.
    const gap = evaluate(null, timeline({ beats: [t.beats[0], t.beats[2], t.beats[3]] }), loadThresholds(), { mode: 'plan' });
    assert.ok(ids(gap).includes('scenes_rendered'), ids(gap).join());
  });

  test('10. corrupted export: a truncated recording (intact header) and an unreadable file are critical', async () => {
    const t = await probe('truncated.mp4');
    const e = evaluate(t, timeline());
    assert.ok(crit(e).includes('file_integrity'), crit(e).join());
    assert.equal(e.classification, 'POOR');
    await assert.rejects(probe('garbage.mp4'), /ffprobe could not read/);
    const g = evaluate(null, timeline());
    assert.ok(crit(g).includes('file_readable'));
    assert.equal(g.classification, 'POOR');
    assert.ok(!crit(evaluate(await probe('good.mp4'), timeline())).includes('file_integrity'));
  });

  test('11. audio-video synchronisation: a 1.5 s late voice is measured and fails critically', async () => {
    const m = await probe('desync.mp4');
    const e = evaluate(m, timeline());
    const sync = e.problems.find((p) => p.id === 'av_sync');
    assert.ok(sync, ids(e).join());
    const off = (sync!.evidence as any).offsetS;
    assert.ok(off > 1.2 && off < 1.8, `measured offset ${off}`);
    assert.equal(sync!.severity, 'critical');
    assert.equal(e.classification, 'POOR');
  });

  test('12. a reel that passes every critical gate is ready to publish', async () => {
    const e = evaluate(await probe('good.mp4'), timeline());
    assert.deepEqual(crit(e), [], e.problems.map((p) => `${p.severity} ${p.id}: ${p.message}`).join('\n'));
    assert.ok(['EXCELLENT', 'GOOD'].includes(e.classification), `${e.classification} ${e.score}\n${e.problems.map((p) => `${p.severity} ${p.id}: ${p.message}`).join('\n')}`);
    assert.equal(e.readyToPublish, true);
    assert.equal(e.dimensions.reduce((s, d) => s + d.weight, 0), 100);
  });
});

describe('reel quality: engine rules', () => {
  const th = loadThresholds();
  test('weights are the product spec: audio 15, export 15, visual 20, captions 15, story 15, pacing 10, technical 10', () => {
    assert.deepEqual(th.weights, { audio: 15, export: 15, visual: 20, captions: 15, story: 15, pacing: 10, technical: 10 });
  });
  test('classification bands and overrides: a critical defect is POOR at any score; a major caps at NEEDS_IMPROVEMENT', () => {
    assert.equal(classify(95, 0, 0, th), 'EXCELLENT');
    assert.equal(classify(85, 0, 0, th), 'GOOD');
    assert.equal(classify(75, 0, 0, th), 'NEEDS_IMPROVEMENT');
    assert.equal(classify(60, 0, 0, th), 'POOR');
    assert.equal(classify(99, 1, 0, th), 'POOR');
    assert.equal(classify(95, 0, 1, th), 'NEEDS_IMPROVEMENT');
    assert.equal(classify(95, 0, 1, loadThresholds({ QUALITY_PASS_ALLOW_MAJOR: 'true' } as any)), 'EXCELLENT');
  });
  test('precheck: speech that cannot be recorded (YouTube embed / browser voice) is blocked before rendering', () => {
    const t = (src: Timeline['audio']['speechSource']) =>
      ({ durationS: 10, scriptText: 'Hi there. Bye now.', beats: [{ text: 'Hi there.', start_s: 0, end_s: 5 }, { text: 'Bye now.', start_s: 5, end_s: 10 }],
        captions: { enabled: true, chunks: [] }, audio: { required: false, narration: false, sourceSpeech: false, music: false, speechExpected: true, speechSource: src } }) as unknown as Timeline;
    for (const src of ['youtube-embed', 'browser-tts', 'none'] as const) {
      const e = evaluate(null, t(src), th, { mode: 'plan' });
      assert.ok(crit(e).includes('speech_source'), src);
    }
    assert.equal(evaluate(null, t('youtube-embed'), th, { mode: 'plan' }).recommendations[0].action, 'attach_source');
    for (const src of ['neural-tts', 'offline-tts', 'source-file'] as const) assert.ok(!crit(evaluate(null, t(src), th, { mode: 'plan' })).includes('speech_source'), src);
  });
  test('hook proposal: the most hook-like sentence of the script is offered as the opening', () => {
    const t = { scriptText: 'I want to talk about sleep today. Why do 90% of people wake up tired? Here is the fix.' } as Timeline;
    assert.equal(proposeHook(t), 'Why do 90% of people wake up tired?');
  });
});

describe('reel quality: measurement units', { skip }, () => {
  test('speech detector: speech yes; tone, synth chords and noise no; digital zeros = silence', () => {
    const gen = (src: string) => s16leToFloat(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-t', '8', '-af', 'highpass=f=200,lowpass=f=3800', '-ar', String(SR), '-ac', '1', '-f', 's16le', '-']));
    const speech = analyzeSpeech(pcmOf(f('voice.wav')), SR);
    assert.ok(speech.speechRatio > 0.5, `speech ${speech.speechRatio}`);
    for (const src of ['sine=f=440:r=16000', "aevalsrc='0.2*(sin(2*PI*261*t)+sin(2*PI*329*t))*exp(-2*mod(t,1.1))':s=16000", 'anoisesrc=r=16000:a=0.1']) {
      const a = analyzeSpeech(gen(src), SR);
      assert.ok(a.speechRatio < 0.1, `${src}: ${a.speechRatio}`);
      assert.ok(a.activeRatio > 0.9, `${src} is audible`);
    }
    const zero = analyzeSpeech(new Float32Array(SR * 4), SR);
    assert.equal(zero.peakDb, -Infinity);
    assert.equal(zero.activeSpans.length, 0);
  });

  test('word alignment on real speech beats the text-length estimate (ground truth from per-word synthesis)', () => {
    const line = "If you haven't found it yet, keep looking. Don't settle.".split(' ');
    const chunks: Float32Array[] = [new Float32Array(SR * 0.3)];
    const truth: number[] = [];
    let t = 0.3;
    line.forEach((w, i) => {
      const txt = f(`w${i}.txt`);
      fs.writeFileSync(txt, w.replace(/[^A-Za-z' ]/g, ''));
      const a = s16leToFloat(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `flite=textfile='${txt}':voice=slt`, '-af',
        'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.05', '-ar', String(SR), '-ac', '1', '-f', 's16le', '-']));
      truth.push(t);
      chunks.push(a);
      t += a.length / SR;
      const gap = /[.!?]$/.test(w) ? 0.35 : /,$/.test(w) ? 0.22 : 0.03;
      chunks.push(new Float32Array(Math.round(gap * SR)));
      t += gap;
    });
    const pcm = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    const al = alignWordsToAudio(pcm, SR, line);
    assert.equal(al.method, 'aligned');
    const err = al.words.reduce((s, w, i) => s + Math.abs(w.start_s - truth[i]), 0) / line.length;
    const wts = line.map((w) => Math.max(w.length * 0.05, 0.2) + (/[.,!?]$/.test(w) ? 0.35 : 0.08));
    const tot = wts.reduce((a, b) => a + b, 0);
    let c = 0;
    const est = wts.map((x) => ((c += x) - x) / tot * (pcm.length / SR));
    const estErr = est.reduce((s, v, i) => s + Math.abs(v - truth[i]), 0) / line.length;
    assert.ok(err < 0.1, `aligned mean error ${Math.round(err * 1000)} ms`);
    assert.ok(err < estErr / 2, `aligned ${Math.round(err * 1000)} ms vs estimated ${Math.round(estErr * 1000)} ms`);
  });

  test('effective detail: a stretched small image is detected; sharp content and flat content are not misjudged', () => {
    const gray = (src: string) => new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 }));
    const sharp = effectiveDetail([gray('testsrc2=s=1080x1920')], 1080, 1920)!;
    assert.equal(sharp.effectiveFactor, 1);
    const stretched = effectiveDetail([gray('testsrc2=s=270x480,scale=1080:1920:flags=bicubic')], 1080, 1920)!;
    assert.ok(stretched.effectiveFactor >= 3, JSON.stringify(stretched));
    assert.equal(effectiveDetail([gray('color=c=0x336699:s=1080x1920')], 1080, 1920), null, 'a flat picture is "too smooth to judge", not "upscaled"');
  });

  test('speech offset: the shift that best explains measured speech', () => {
    const exp = [{ start: 0, end: 2 }, { start: 3, end: 5 }];
    const heard = exp.map((s) => ({ start: s.start + 1.5, end: s.end + 1.5 }));
    assert.equal(speechOffset(exp, heard).offsetS, 1.5);
    assert.equal(speechOffset(exp, exp).offsetS, 0);
  });
});

describe('reel quality: AI storytelling review', () => {
  const t = { beats: [{ text: 'Why do most people never finish?', start_s: 0, end_s: 3 }, { text: 'Follow for more.', start_s: 3, end_s: 5 }] } as unknown as Timeline;
  test('evidence quotes are verified against the script; unverifiable judgements are not scored', () => {
    const r = parseReview({
      criteria: [
        { id: 'hook', score: 8, verdict: 'Question hook.', evidence: ['Why do most people never finish'] },
        { id: 'ending', score: 2, verdict: 'Weak.', evidence: ['Subscribe to my channel now'] },
        { id: 'made_up', score: 9, verdict: 'x', evidence: ['x'] },
      ],
      summary: 'ok',
    }, t, 'stub-model')!;
    assert.equal(r.criteria.length, 2);
    const checks = reviewChecks(r);
    assert.equal(checks[0].measured, true);
    assert.equal(checks[0].passed, true);
    assert.equal(checks[1].measured, false, 'hallucinated evidence is ignored for scoring');
    assert.ok(checks.every((c) => c.severity !== 'critical'), 'the AI can never fail (or rescue) a reel on its own');
  });
  test('no LLM configured: storytelling falls back to measurable proxies and says so', async () => {
    const r = await runAiReview(undefined, t, null);
    assert.equal(r.review, undefined);
    assert.match(r.note, /not configured/);
    const failing = await runAiReview(async () => {
      throw new Error('GEMINI_API_KEY is not configured');
    }, t, null);
    assert.match(failing.note, /unavailable/);
  });
  test('an AI review cannot rescue a technically broken reel', () => {
    const media = null as unknown as MediaFacts;
    const r = parseReview({ criteria: ['hook', 'continuity', 'relevance', 'progression', 'ending'].map((id) => ({ id, score: 10, verdict: 'great', evidence: ['Follow for more'] })) }, t, 'stub')!;
    const e = evaluate(media, { ...t, durationS: 5, scriptText: 'Why do most people never finish? Follow for more.', captions: { enabled: true, chunks: [] }, audio: { required: true, narration: true, sourceSpeech: false, music: false } } as Timeline, loadThresholds(), { extraChecks: reviewChecks(r), aiReview: r });
    assert.equal(e.classification, 'POOR');
  });
});
