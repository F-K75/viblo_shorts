/**
 * Speaker-aware vertical cropping for landscape source footage.
 *
 * A centre crop of a 16:9 frame to 9:16 keeps only the middle ~32 % of the picture, so a speaker standing left or
 * right of centre is cut off. This module finds where the subject is over the clip and turns that into a calm,
 * camera-operator-like crop path.
 *
 * Two layers, deliberately separated:
 *  - PURE (no DOM, unit-tested in node): per-frame pixel scoring, subject position from column scores, path
 *    smoothing (median + dead zone + speed-limited easing + clamping) and the time lookup.
 *  - BROWSER: `analyzeSubjectTrack` seeks a private <video> through the range, downsamples frames onto an offscreen
 *    canvas and feeds them to the pure scorers. No network models: classic signals only (motion, skin tone, edges),
 *    plus the Shape Detection API's FaceDetector when the browser happens to have it.
 */

/** One analysed moment: `t` in source-file seconds, `x` subject centre (0..1 of frame width), `confidence` 0..1. */
export interface SubjectSample {
  t: number;
  x: number;
  confidence: number;
}

/** A crop path: the crop window's LEFT edge (normalized 0..1 of the frame width) at each time (source seconds). */
export interface CropPath {
  times: number[];
  lefts: number[];
  /** Crop window width as a fraction of the frame width (1 = no horizontal crop possible). */
  cropFrac: number;
}

export interface SmoothOptions {
  /** Median filter window in samples (odd). Kills single-frame outliers (a hand wave, a passing car). */
  medianWindow?: number;
  /** Don't re-target for shifts smaller than this (fraction of frame width). Static shots stay static. */
  deadZone?: number;
  /** Fastest allowed pan, in frame widths per second. */
  maxSpeed?: number;
  /** Easing time constant (s): the crop approaches its target exponentially, capped by maxSpeed. */
  easeTau?: number;
  /** Samples below this confidence carry no information: the previous target is kept. */
  minConfidence?: number;
}

const DEFAULTS: Required<SmoothOptions> = { medianWindow: 5, deadZone: 0.06, maxSpeed: 0.35, easeTau: 0.35, minConfidence: 0.15 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fraction of the frame width a `targetAspect` (w/h) crop spans at full height. 9:16 of 1280x720 → 0.316. */
export function cropFraction(videoWidth: number, videoHeight: number, targetAspect = 9 / 16): number {
  if (!videoWidth || !videoHeight) return 1;
  return Math.min(1, (videoHeight * targetAspect) / videoWidth);
}

/** Left edge (normalized) of a crop window of width `cropFrac` centred on `center`, kept inside the frame. */
export function leftForCenter(center: number, cropFrac: number): number {
  if (cropFrac >= 1) return 0;
  return clamp(center - cropFrac / 2, 0, 1 - cropFrac);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Turns raw per-sample subject positions into a stable crop path. Deterministic, browser-free.
 *  1. low-confidence samples inherit the last confident position (or the centre);
 *  2. running median removes outliers;
 *  3. hysteresis: the target only moves when the subject leaves a dead zone around the current target;
 *  4. the crop eases toward the target (exponential approach) but never faster than `maxSpeed`;
 *  5. everything is clamped so the window stays inside the frame.
 */
export function smoothCropPath(samples: SubjectSample[], cropFrac: number, opts: SmoothOptions = {}): CropPath {
  const o = { ...DEFAULTS, ...opts };
  const sorted = [...samples].filter((s) => Number.isFinite(s.t) && Number.isFinite(s.x)).sort((a, b) => a.t - b.t);
  if (!sorted.length || cropFrac >= 1) {
    return { times: sorted.map((s) => s.t), lefts: sorted.map(() => 0), cropFrac: Math.min(1, cropFrac) };
  }
  const lo = cropFrac / 2;
  const hi = 1 - cropFrac / 2;

  // 1. Fill gaps. Before the first confident sample, use the first confident one (no pointless pan at the start).
  const firstConfident = sorted.find((s) => s.confidence >= o.minConfidence);
  let last = firstConfident ? firstConfident.x : 0.5;
  const filled = sorted.map((s) => {
    if (s.confidence >= o.minConfidence) last = s.x;
    return clamp(last, lo, hi);
  });

  // 2. Running median (window shrinks at the edges).
  const half = Math.max(0, Math.floor(o.medianWindow / 2));
  const med = filled.map((_, i) => median(filled.slice(Math.max(0, i - half), i + half + 1)));

  // 3 + 4. Hysteresis target, then a speed-limited ease toward it.
  let target = med[0];
  let pos = med[0];
  const centers: number[] = [];
  for (let i = 0; i < med.length; i++) {
    if (Math.abs(med[i] - target) > o.deadZone) target = med[i];
    if (i > 0) {
      const dt = Math.max(0, sorted[i].t - sorted[i - 1].t);
      const delta = target - pos;
      const eased = delta * (1 - Math.exp(-dt / Math.max(1e-3, o.easeTau)));
      const cap = o.maxSpeed * dt;
      pos += clamp(eased, -cap, cap);
      if (Math.abs(target - pos) < 0.002) pos = target;
    }
    centers.push(clamp(pos, lo, hi));
  }
  return { times: sorted.map((s) => s.t), lefts: centers.map((c) => leftForCenter(c, cropFrac)), cropFrac };
}

/** Crop window left edge (normalized 0..1) at time `t` (source seconds), linearly interpolated, held at the ends. */
export function cropXAt(path: CropPath | null | undefined, t: number): number {
  if (!path || !path.times.length) return path ? leftForCenter(0.5, path.cropFrac) : 0;
  const { times, lefts } = path;
  if (t <= times[0]) return lefts[0];
  const n = times.length;
  if (t >= times[n - 1]) return lefts[n - 1];
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (times[m] <= t) a = m;
    else b = m;
  }
  const span = times[b] - times[a];
  const k = span > 0 ? (t - times[a]) / span : 0;
  return lefts[a] + (lefts[b] - lefts[a]) * k;
}

/** Crop window centre (normalized) at time `t` — what `drawSourceFrame` takes. */
export function cropCenterAt(path: CropPath | null | undefined, t: number): number {
  if (!path) return 0.5;
  return cropXAt(path, t) + path.cropFrac / 2;
}

/** CSS `object-position` x percentage for an `object-fit: cover` element showing the window at `left`. */
export function objectPositionPercent(left: number, cropFrac: number): number {
  if (cropFrac >= 1) return 50;
  return clamp((left / (1 - cropFrac)) * 100, 0, 100);
}

// ---------------------------------------------------------------------------------------------------------------
// Pure per-frame scoring
// ---------------------------------------------------------------------------------------------------------------

/** Skin tone in YCbCr (the classic Chai & Ngan box, slightly widened for compressed video). */
export function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 45 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Scores each column of a downscaled RGBA frame for "a person is here":
 * skin pixels, pixels that changed since the previous frame (people talk, gesture and move; backgrounds don't),
 * moving skin counts extra, and a little edge density (faces and bodies are textured, walls are not).
 * Returns the column scores and this frame's luma (pass it back as `prevLuma` next time).
 */
export function scoreColumns(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  prevLuma?: Float32Array | null,
): { scores: Float32Array; luma: Float32Array } {
  const luma = new Float32Array(width * height);
  const scores = new Float32Array(width);
  const hasPrev = Boolean(prevLuma && prevLuma.length === luma.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[i] = l;
      const skin = isSkin(r, g, b);
      const moving = hasPrev && Math.abs(l - prevLuma![i]) > 18;
      const edge = x > 0 && Math.abs(l - luma[i - 1]) > 24;
      scores[x] += (skin ? 1 : 0) + (moving ? 2 : 0) + (skin && moving ? 3 : 0) + (edge ? 0.25 : 0);
    }
  }
  // Normalize by height so thresholds don't depend on the analysis resolution.
  for (let x = 0; x < width; x++) scores[x] /= height;
  return { scores, luma };
}

/**
 * Subject centre from column scores: the window (≈ half the crop width) holding the most evidence, with a mild
 * centre prior so ties and diffuse frames prefer the middle. Confidence says how concentrated that evidence is.
 */
export function subjectFromColumns(scores: ArrayLike<number>, cropFrac: number): { x: number; confidence: number } {
  const n = scores.length;
  if (!n) return { x: 0.5, confidence: 0 };
  let total = 0;
  for (let i = 0; i < n; i++) total += scores[i];
  // Too little evidence anywhere (static, skinless frame): say so instead of guessing.
  if (total / n < 0.01) return { x: 0.5, confidence: 0 };
  const win = Math.max(1, Math.round(n * Math.min(1, cropFrac) * 0.5));
  let sum = 0;
  for (let i = 0; i < win; i++) sum += scores[i];
  let best = -1;
  let bestStart = 0;
  let bestMass = 0;
  for (let s = 0; s + win <= n; s++) {
    if (s > 0) sum += scores[s + win - 1] - scores[s - 1];
    const c = (s + win / 2) / n;
    const prior = 1 - 0.25 * Math.pow((c - 0.5) * 2, 2); // up to 25 % penalty at the extreme edges
    const v = sum * prior;
    if (v > best) {
      best = v;
      bestStart = s;
      bestMass = sum;
    }
  }
  // Weighted centroid inside the winning window gives sub-window precision.
  let wx = 0;
  let ws = 0;
  for (let i = bestStart; i < bestStart + win; i++) {
    wx += scores[i] * (i + 0.5);
    ws += scores[i];
  }
  const x = ws > 0 ? wx / ws / n : (bestStart + win / 2) / n;
  // Share of the evidence inside the window, relative to what a uniform spread would give.
  const share = bestMass / total;
  const uniform = win / n;
  const confidence = clamp((share - uniform) / Math.max(1e-6, 1 - uniform), 0, 1);
  return { x, confidence };
}

// ---------------------------------------------------------------------------------------------------------------
// Browser analysis
// ---------------------------------------------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Samples per second (lowered automatically for long ranges so analysis stays quick). */
  fps?: number;
  /** Analysis width in pixels. */
  width?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

function seekTo(video: HTMLVideoElement, t: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      reject(new DOMException('aborted', 'AbortError'));
    };
    // A seek that never reports back (odd containers) must not hang analysis: move on with whatever frame is shown.
    const timer = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    signal?.addEventListener('abort', onAbort);
    video.currentTime = t;
  });
}

/**
 * Samples [from, to] (source-file seconds) of a video and returns the smoothed crop path for a 9:16 window.
 * Uses its own <video> element so the visible preview is never disturbed. Rejects with AbortError when cancelled.
 */
export async function analyzeSubjectTrack(
  src: string | HTMLVideoElement,
  from: number,
  to: number,
  opts: AnalyzeOptions = {},
): Promise<{ path: CropPath; samples: SubjectSample[] }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = typeof src === 'string' ? src : src.currentSrc || src.src;
  try {
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) return resolve();
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('could not read the source video'));
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropFrac = cropFraction(vw, vh);
    const end = Math.min(to, Number.isFinite(video.duration) ? video.duration - 0.05 : to);
    const start = clamp(from, 0, Math.max(0, end));
    if (cropFrac >= 1 || end <= start) return { path: { times: [], lefts: [], cropFrac }, samples: [] };

    const aw = Math.max(32, Math.round(opts.width ?? 160));
    const ah = Math.max(18, Math.round((aw * vh) / vw));
    const canvas = document.createElement('canvas');
    canvas.width = aw;
    canvas.height = ah;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d unavailable');

    const FaceDetectorCtor = (globalThis as any).FaceDetector;
    let faceDetector: any = null;
    if (typeof FaceDetectorCtor === 'function') {
      try {
        faceDetector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 3 });
      } catch {
        faceDetector = null;
      }
    }

    const fps = Math.min(opts.fps ?? 4, 240 / (end - start)); // at most ~240 seeks
    const step = 1 / fps;
    const samples: SubjectSample[] = [];
    let prevLuma: Float32Array | null = null;
    const count = Math.max(1, Math.floor((end - start) / step) + 1);
    for (let k = 0; k < count; k++) {
      const t = start + k * step;
      await seekTo(video, t, opts.signal);
      ctx.drawImage(video, 0, 0, aw, ah);
      const { data } = ctx.getImageData(0, 0, aw, ah);
      const { scores, luma } = scoreColumns(data, aw, ah, prevLuma);
      // Motion is only meaningful between consecutive samples; the first frame relies on skin/edges alone.
      prevLuma = luma;
      let sample: SubjectSample = { t, ...subjectFromColumns(scores, cropFrac) };
      if (faceDetector) {
        try {
          const faces: Array<{ boundingBox: DOMRectReadOnly }> = await faceDetector.detect(canvas);
          if (faces.length) {
            const biggest = faces.reduce((a, f) => (f.boundingBox.width * f.boundingBox.height > a.boundingBox.width * a.boundingBox.height ? f : a));
            sample = { t, x: (biggest.boundingBox.x + biggest.boundingBox.width / 2) / aw, confidence: 1 };
          }
        } catch {
          faceDetector = null; // unsupported on this platform after all: stay on the classic signals
        }
      }
      samples.push(sample);
      opts.onProgress?.((k + 1) / count);
    }
    return { path: smoothCropPath(samples, cropFrac), samples };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
