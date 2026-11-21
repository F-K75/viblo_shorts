/**
 * Deterministic speech-activity analysis over mono PCM (pure: no I/O, unit-testable).
 *
 * An audio STREAM is not audio. This module answers three different questions about the decoded signal:
 *  1. Is there any signal at all?               (peak / RMS; digital silence = every sample ~0)
 *  2. Where is something audible?               (voice-band energy per 10 ms frame, adaptive threshold → active spans)
 *  3. Does the audible part look like speech?   (syllabic modulation: speech energy rises and falls 2–8 times a second,
 *                                                 sustained tones, pads and steady noise do not)
 * The speech test is a classic envelope-modulation-spectrum heuristic, not a speech recogniser: it is reported as such.
 */

export const FRAME_S = 0.01;

export interface ActivitySpan {
  start: number;
  end: number;
}

export interface SpeechAnalysis {
  sampleRate: number;
  durationS: number;
  peakDb: number; // dBFS of the largest absolute sample (-Infinity for digital silence)
  rmsDb: number; // dBFS over the whole signal
  /** Frames (10 ms) with voice-band energy above the adaptive threshold, merged into spans. */
  activeSpans: ActivitySpan[];
  activeRatio: number;
  /** Spans of active audio whose envelope modulates like speech (2–8 Hz syllable rate). */
  speechSpans: ActivitySpan[];
  speechRatio: number;
  /** Mean share of envelope modulation energy in the 2–8 Hz band over active windows (0..1). */
  modulationIndex: number;
  /** Per-frame level in dBFS (10 ms), for alignment and sync checks. */
  frameDb: Float32Array;
  thresholdDb: number;
}

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** RMS level per 10 ms frame in dBFS. */
export function frameLevels(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * FRAME_S));
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += samples[i] * samples[i];
    out[f] = toDb(Math.sqrt(s / hop));
  }
  return out;
}

/** Merges active frames into spans, bridging gaps shorter than bridgeS and dropping spans shorter than minS. */
export function framesToSpans(active: ArrayLike<boolean>, bridgeS = 0.25, minS = 0.08): ActivitySpan[] {
  const spans: ActivitySpan[] = [];
  let start = -1;
  for (let f = 0; f <= active.length; f++) {
    const on = f < active.length && active[f];
    if (on && start < 0) start = f;
    if (!on && start >= 0) {
      spans.push({ start: start * FRAME_S, end: f * FRAME_S });
      start = -1;
    }
  }
  const merged: ActivitySpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < bridgeS) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= minS).map((s) => ({ start: round3(s.start), end: round3(s.end) }));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Share of envelope power in the 2–8 Hz band (syllable rate) for a window of frame levels (linear amplitude).
 * Plain DFT over ≤ 200 frames: cheap and exact enough.
 */
export function modulationShare(env: ArrayLike<number>): number {
  const n = env.length;
  if (n < 50) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  if (mean <= 0) return 0;
  const fps = 1 / FRAME_S;
  let band = 0;
  let total = 0;
  for (let k = 1; k <= n / 2; k++) {
    const hz = (k * fps) / n;
    if (hz > 20) break;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n;
      const v = env[i] / mean - 1;
      re += v * Math.cos(a);
      im -= v * Math.sin(a);
    }
    const p = re * re + im * im;
    total += p;
    if (hz >= 2 && hz <= 8) band += p;
  }
  return total > 0 ? band / total : 0;
}

export interface SpeechOptions {
  /** Absolute floor: nothing quieter than this counts as active (dBFS). */
  floorDb?: number;
  /** Active = louder than (loud reference − rangeDb). */
  rangeDb?: number;
  /** Modulation share above which a window is speech-like. */
  speechModulation?: number;
  /** Speech swings between syllables and pauses: p90 − p10 of frame levels in a window must reach this (dB). */
  minSpreadDb?: number;
  windowS?: number;
}

/**
 * Analyses mono PCM (ideally already band-limited to the voice band, 200–3800 Hz, by the decoder).
 * Thresholds are relative to the loud parts of THIS signal so quiet but present narration still counts.
 */
export function analyzeSpeech(samples: Float32Array, sampleRate: number, opts: SpeechOptions = {}): SpeechAnalysis {
  const floorDb = opts.floorDb ?? -50;
  const rangeDb = opts.rangeDb ?? 30;
  const speechMod = opts.speechModulation ?? 0.45;
  const minSpreadDb = opts.minSpreadDb ?? 10;
  const windowFrames = Math.round((opts.windowS ?? 2) / FRAME_S);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sum += samples[i] * samples[i];
  }
  const durationS = samples.length / sampleRate;
  const frameDb = frameLevels(samples, sampleRate);
  // Loud reference: 95th percentile of finite frame levels (robust to a single click).
  const finite = Array.from(frameDb).filter(Number.isFinite).sort((a, b) => a - b);
  const loud = finite.length ? finite[Math.floor(finite.length * 0.95)] : -Infinity;
  const thresholdDb = Math.max(floorDb, loud - rangeDb);
  const active = Array.from(frameDb, (d) => d > thresholdDb);
  const activeSpans = framesToSpans(active);

  // Speech-likeness per window (hop = half a window) over the linear envelope.
  const env = Array.from(frameDb, (d) => (Number.isFinite(d) ? 10 ** (d / 20) : 0));
  const speechFrames = new Array<boolean>(frameDb.length).fill(false);
  const shares: number[] = [];
  const hop = Math.max(1, Math.floor(windowFrames / 2));
  for (let s = 0; s < frameDb.length; s += hop) {
    const e = Math.min(frameDb.length, s + windowFrames);
    if (e - s < windowFrames / 2) break;
    let act = 0;
    for (let i = s; i < e; i++) if (active[i]) act++;
    if (act / (e - s) < 0.15) continue; // mostly quiet: nothing to judge
    const share = modulationShare(env.slice(s, e));
    shares.push(share);
    const lv = Array.from(frameDb.slice(s, e), (d) => (Number.isFinite(d) ? d : -120)).sort((a, b) => a - b);
    const spread = lv[Math.floor(lv.length * 0.9)] - lv[Math.floor(lv.length * 0.1)];
    if (share >= speechMod && spread >= minSpreadDb) for (let i = s; i < e; i++) if (active[i]) speechFrames[i] = true;
  }
  // Speech windows are 2 s wide; snap them to the 10 ms activity spans they overlap so onsets/ends are precise.
  const coarse = framesToSpans(speechFrames);
  const speechSpans = activeSpans.filter((a) => coarse.some((c) => c.start < a.end && c.end > a.start));
  const spanSum = (sp: ActivitySpan[]) => sp.reduce((t, x) => t + (x.end - x.start), 0);
  return {
    sampleRate,
    durationS,
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sum / Math.max(1, samples.length))),
    activeSpans,
    activeRatio: durationS ? spanSum(activeSpans) / durationS : 0,
    speechSpans,
    speechRatio: durationS ? spanSum(speechSpans) / durationS : 0,
    modulationIndex: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0,
    frameDb,
    thresholdDb,
  };
}

/** Converts little-endian signed 16-bit PCM to floats in [-1, 1]. */
export function s16leToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Total overlap (seconds) between two sorted span lists. */
export function overlapS(a: ActivitySpan[], b: ActivitySpan[]): number {
  let i = 0;
  let j = 0;
  let t = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].start, b[j].start);
    const hi = Math.min(a[i].end, b[j].end);
    if (hi > lo) t += hi - lo;
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return t;
}
