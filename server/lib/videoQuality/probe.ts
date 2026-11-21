import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { MediaFacts } from './models.ts';
import { analyzeSpeech, s16leToFloat } from './speech.ts';

/**
 * Measures a media file with ffprobe and ffmpeg analysis filters (no shell: argument arrays only, with a timeout).
 * Everything the evaluator decides on comes from here, so a reel is judged on what the file actually contains.
 */

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000); // bounded memory on very long files
    });
    proc.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/** True when the 'moov' box precedes 'mdat' at the top level (web "fast start"). Null if neither is found. */
export function detectFaststart(file: string): boolean | null {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (boxSize < 8) return null;
      pos += boxSize;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const segments = (text: string, startKey: string, endKey: string) => {
  const starts = [...text.matchAll(new RegExp(`${startKey}:\\s*(-?[0-9.]+)`, 'g'))].map((m) => Number(m[1]));
  const ends = [...text.matchAll(new RegExp(`${endKey}:\\s*(-?[0-9.]+)`, 'g'))].map((m) => Number(m[1]));
  return starts.map((s, i) => ({ start: s, end: Number.isFinite(ends[i]) ? ends[i] : Number.NaN }));
};

const lastNumber = (text: string, re: RegExp): number | null => {
  const all = [...text.matchAll(re)];
  if (!all.length) return null;
  const v = Number(all[all.length - 1][1]);
  return Number.isFinite(v) ? v : null;
};

/** 64-bit difference hash of 9x8 grayscale frames (one per row of 72 bytes). */
export function dHashFrames(raw: Buffer): string[] {
  const hashes: string[] = [];
  for (let off = 0; off + 72 <= raw.length; off += 72) {
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        bits = (bits << 1n) | (raw[off + y * 9 + x] > raw[off + y * 9 + x + 1] ? 1n : 0n);
      }
    }
    hashes.push(bits.toString(16).padStart(16, '0'));
  }
  return hashes;
}

const STAB_W = 32;
const STAB_H = 56;

/**
 * Splits 2 fps thumbnails (32x56 gray) into visual states using mean absolute luma difference (MAD). Calibrated on
 * real files: hard cuts jump 40-75 between samples, a slow zoom on a still drifts ≤ 2 per sample (≤ 20 in total), the
 * failed reel's per-scene zoom reset jumps 12.6. A new state starts on a cut (> cutThreshold) or after a large drift.
 * States whose anchors look alike are clustered, so "the same picture again later" is counted once.
 */
export function visualStates(raw: Buffer, stepS: number, cutThreshold = 15, driftThreshold = 30, clusterThreshold = 25): NonNullable<MediaFacts['analysis']['stability']> {
  const size = STAB_W * STAB_H;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + size <= raw.length; o += size) frames.push(raw.subarray(o, o + size));
  const mad = (a: Uint8Array, b: Uint8Array) => {
    let d = 0;
    for (let i = 0; i < size; i++) d += Math.abs(a[i] - b[i]);
    return d / size;
  };
  let lumaSum = 0;
  let varSum = 0;
  let dark = 0;
  for (const f of frames) {
    let m = 0;
    for (let i = 0; i < size; i++) m += f[i];
    m /= size;
    let v = 0;
    for (let i = 0; i < size; i++) v += (f[i] - m) ** 2;
    lumaSum += m;
    varSum += Math.sqrt(v / size);
    if (m < 25) dark++;
  }
  const states: Array<{ start: number; end: number; cluster: number; anchor: Uint8Array }> = [];
  const anchors: Uint8Array[] = [];
  frames.forEach((f, i) => {
    const cur = states[states.length - 1];
    // Same state unless the picture CUTS (jumps between consecutive samples) or has drifted far from the state's
    // first frame (a long pan). A slow zoom changes a little each sample and never cuts: it stays one state.
    if (cur && mad(frames[i - 1], f) <= cutThreshold && mad(cur.anchor, f) <= driftThreshold) {
      cur.end = (i + 1) * stepS;
      return;
    }
    let cluster = anchors.findIndex((a) => mad(a, f) <= clusterThreshold);
    if (cluster < 0) {
      anchors.push(f);
      cluster = anchors.length - 1;
    }
    states.push({ start: i * stepS, end: (i + 1) * stepS, cluster, anchor: f });
  });
  const n = Math.max(1, frames.length);
  return {
    states: states.map(({ start, end, cluster }) => ({ start, end, cluster })),
    distinctVisuals: anchors.length,
    longestStaticS: states.reduce((m, s) => Math.max(m, s.end - s.start), 0),
    meanLuma: Math.round((lumaSum / n) * 10) / 10,
    contrast: Math.round((varSum / n) * 10) / 10,
    darkRatio: Math.round((dark / n) * 1000) / 1000,
  };
}

/** Video packet timestamps: monotonic decode order, largest gap between frames and frame-interval jitter. */
export function packetTiming(csv: string, videoStartS: number, audioStartS: number | null, declaredFps: number): NonNullable<MediaFacts['analysis']['timing']> {
  const rows = csv.split('\n').map((l) => l.split(',')).filter((r) => r.length >= 2 && r[0] !== 'N/A');
  const pts = rows.map((r) => Number(r[0])).filter(Number.isFinite).sort((a, b) => a - b);
  const dts = rows.map((r) => Number(r[1]));
  let nonMono = 0;
  for (let i = 1; i < dts.length; i++) if (Number.isFinite(dts[i]) && Number.isFinite(dts[i - 1]) && dts[i] < dts[i - 1]) nonMono++;
  const gaps = pts.slice(1).map((p, i) => p - pts[i]);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sd = gaps.length ? Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) : 0;
  return {
    videoStartS: Math.round(videoStartS * 1000) / 1000,
    audioStartS: audioStartS === null ? null : Math.round(audioStartS * 1000) / 1000,
    declaredFps: Math.round(declaredFps * 100) / 100,
    packets: rows.length,
    nonMonotonicDts: nonMono,
    maxFrameGapS: Math.round((gaps.length ? Math.max(...gaps) : 0) * 1000) / 1000,
    frameIntervalJitterMs: Math.round(sd * 10000) / 10,
  };
}

/**
 * Detail retained when a W×H gray frame is scaled down by k (box average) and back up (bilinear), per tile.
 * Returns the MEDIAN tile PSNR, so small sharp overlays (burned-in captions, progress bars) do not hide an upscaled
 * picture: they occupy a few tiles, the picture occupies most of them.
 */
export function tileRoundTripPsnr(frame: Uint8Array, W: number, H: number, k: number, tiles = 8): number[] {
  const w = Math.floor(W / k);
  const h = Math.floor(H / k);
  if (w < 2 || h < 2) return [];
  const small = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) s += frame[(y * k + dy) * W + x * k + dx];
      small[y * w + x] = s / (k * k);
    }
  }
  const tw = Math.floor(W / tiles);
  const th = Math.floor(H / tiles);
  const mse = new Float64Array(tiles * tiles);
  for (let y = 0; y < th * tiles; y++) {
    const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / k - 0.5));
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < tw * tiles; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / k - 0.5));
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const a = small[y0 * w + x0];
      const b = small[y0 * w + x0 + 1];
      const c = small[(y0 + 1) * w + x0];
      const d = small[(y0 + 1) * w + x0 + 1];
      const v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      const e = frame[y * W + x] - v;
      mse[Math.floor(y / th) * tiles + Math.floor(x / tw)] += e * e;
    }
  }
  return Array.from(mse, (m) => {
    const mm = m / (tw * th);
    return mm <= 1e-6 ? 99 : 10 * Math.log10((255 * 255) / mm);
  });
}

/** Largest factor whose round trip keeps the picture (median tile PSNR >= 43 dB) = how much the frame was upscaled. */
export function effectiveDetail(frames: Uint8Array[], W: number, H: number) {
  const factors = [2, 3, 4];
  const psnrByFactor: Record<string, number> = {};
  // Only tiles with real structure are judged: a tile that survives even a 16x round trip is flat (sky, gradient,
  // plain background) and says nothing about resolution.
  const coarse = frames.map((f) => tileRoundTripPsnr(f, W, H, 16));
  const informative = coarse.map((tilesP) => tilesP.map((p) => p < 38));
  const informativeShare = informative.flat().filter(Boolean).length / Math.max(1, informative.flat().length);
  if (informativeShare < 0.2) return null; // too smooth to judge
  for (const k of factors) {
    const vals = frames.flatMap((f, i) => tileRoundTripPsnr(f, W, H, k).filter((_, t) => informative[i][t])).sort((a, b) => a - b);
    psnrByFactor[String(k)] = Math.round((vals[Math.floor(vals.length / 2)] ?? 0) * 10) / 10;
  }
  let effectiveFactor = 1;
  // 43 dB: genuinely detailed frames measured ≤ 40.8 dB even at k=2; stretched images ≥ 43.9 dB at their factor.
  for (const k of factors) if (psnrByFactor[String(k)] >= 43) effectiveFactor = k;
  return { psnrByFactor, effectiveFactor, effectiveWidth: Math.round(W / effectiveFactor), effectiveHeight: Math.round(H / effectiveFactor), frames: frames.length };
}

async function measureDetail(ffmpeg: string, file: string, W: number, H: number, durationS: number, timeoutMs: number) {
  const every = Math.max(1, durationS / 8); // ~8 frames per reel, full resolution, gray
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', `fps=1/${every.toFixed(3)},format=gray`, '-frames:v', '10', '-f', 'rawvideo', '-'], timeoutMs);
  const size = W * H;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + size <= stdout.length; o += size) frames.push(new Uint8Array(stdout.buffer, stdout.byteOffset + o, size));
  return frames.length ? effectiveDetail(frames, W, H) : null;
}

export async function probeMedia(
  file: string,
  opts: { ffprobe?: string; ffmpeg?: string; timeoutMs?: number } = {},
): Promise<MediaFacts> {
  const ffprobe = opts.ffprobe || 'ffprobe';
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const pr = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file], timeoutMs);
  if (pr.code !== 0) throw new Error(`ffprobe could not read the file: ${pr.stderr.split('\n').find(Boolean)?.slice(0, 200) || 'unknown error'}`);
  const info = JSON.parse(pr.stdout.toString('utf8') || '{}');
  const vs = (info.streams || []).find((s: any) => s.codec_type === 'video');
  const as = (info.streams || []).find((s: any) => s.codec_type === 'audio');
  const durationS = Number(info.format?.duration) || Number(vs?.duration) || 0;
  const rate = (r: string | undefined) => {
    const [n, d] = String(r || '0/1').split('/').map(Number);
    return d ? n / d : 0;
  };
  const frames = Number(vs?.nb_read_frames) || Number(vs?.nb_frames) || 0;
  // avg_frame_rate is exact for constant-rate files; MediaRecorder output is variable-rate and may declare nonsense
  // (e.g. 1000/1), so fall back to frames / VIDEO-stream duration (the container duration includes longer audio).
  const avg = vs ? rate(vs.avg_frame_rate) : 0;
  const videoDur = Number(vs?.duration) || durationS;
  const fps = vs ? (avg > 1 && avg <= 120 ? avg : frames && videoDur ? frames / videoDur : rate(vs.r_frame_rate)) : 0;

  const facts: MediaFacts = {
    container: String(info.format?.format_name || ''),
    durationS,
    sizeBytes: fs.statSync(file).size,
    faststart: /mp4|mov/.test(String(info.format?.format_name || '')) ? detectFaststart(file) : null,
    video: vs
      ? {
          codec: String(vs.codec_name || ''),
          profile: vs.profile,
          width: Number(vs.width) || 0,
          height: Number(vs.height) || 0,
          pixFmt: String(vs.pix_fmt || ''),
          fps: Math.round(fps * 100) / 100,
          frames,
          bitrate: Number(vs.bit_rate) || undefined,
        }
      : null,
    audio: as
      ? {
          codec: String(as.codec_name || ''),
          sampleRate: Number(as.sample_rate) || 0,
          channels: Number(as.channels) || 0,
          durationS: Number(as.duration) || durationS,
        }
      : null,
    analysis: {
      blurMean: null,
      blackSegments: [],
      freezeSegments: [],
      sceneCuts: [],
      effectiveFps: null,
      loudnessLufs: null,
      truePeakDb: null,
      meanVolumeDb: null,
      clippedSamples: null,
      silenceSegments: [],
      frameHashes: [],
      audioSignal: null,
      detail: null,
      stability: null,
      timing: null,
    },
  };

  const jobs: Promise<void>[] = [];
  if (vs) {
    // Visual analysis on a downscaled 10 fps copy: enough for blur, black, freeze and cut detection, and fast.
    jobs.push(
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf',
        'fps=10,scale=360:-2,blurdetect,blackdetect=d=0.3:pix_th=0.10,freezedetect=n=0.003:d=1,scdet=t=12:s=1', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          facts.analysis.blurMean = lastNumber(stderr, /blur mean:\s*([0-9.]+)/g);
          facts.analysis.blackSegments = segments(stderr, 'black_start', 'black_end');
          facts.analysis.freezeSegments = segments(stderr, 'freeze_start', 'freeze_end')
            .map((s) => ({ start: s.start, end: Number.isFinite(s.end) ? s.end : durationS }));
          facts.analysis.sceneCuts = [...stderr.matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.05);
        }),
      // Distinct frames: mpdecimate drops frames that repeat the previous one (dropped/duplicated encoder frames).
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', 'scale=270:-2,mpdecimate', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          const kept = lastNumber(stderr, /frame=\s*(\d+)/g);
          facts.analysis.effectiveFps = kept !== null && durationS > 0 ? Math.round((kept / durationS) * 10) / 10 : null;
        }),
      run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', 'fps=1,scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'], timeoutMs)
        .then(({ stdout }) => {
          facts.analysis.frameHashes = dHashFrames(stdout);
        }),
    );
  }
  if (vs) {
    const W = Number(vs.width) || 0;
    const H = Number(vs.height) || 0;
    jobs.push(
      run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', `fps=2,scale=${STAB_W}:${STAB_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], timeoutMs)
        .then(({ stdout }) => {
          facts.analysis.stability = visualStates(stdout, 0.5);
        }),
      run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time', '-of', 'csv=p=0', file], timeoutMs)
        .then(({ stdout }) => {
          facts.analysis.timing = packetTiming(stdout.toString('utf8'), Number(vs.start_time) || 0, as ? Number(as.start_time) || 0 : null, rate(vs.r_frame_rate));
        }),
    );
    if (W >= 64 && H >= 64) jobs.push(measureDetail(ffmpeg, file, W, H, durationS, timeoutMs).then((d) => { facts.analysis.detail = d; }));
  }
  if (as) {
    jobs.push(
      // Decoded signal in the voice band (200-3800 Hz), 16 kHz mono: digital silence, activity and speech-likeness.
      run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=200,lowpass=f=3800', '-f', 's16le', '-'], timeoutMs)
        .then(({ stdout }) => {
          const samples = s16leToFloat(stdout);
          // Peak/RMS on the full band would differ slightly; zero samples are zero in every band, which is what matters.
          let peak = 0;
          for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
          const sp = analyzeSpeech(samples, 16000);
          const fin = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
          facts.analysis.audioSignal = {
            peakDb: fin(sp.peakDb),
            rmsDb: fin(sp.rmsDb),
            digitalSilence: peak < 1 / 32768 * 2, // every sample within ±1 LSB of zero
            activeSpans: sp.activeSpans,
            activeRatio: Math.round(sp.activeRatio * 1000) / 1000,
            speechSpans: sp.speechSpans,
            speechRatio: Math.round(sp.speechRatio * 1000) / 1000,
            modulationIndex: Math.round(sp.modulationIndex * 1000) / 1000,
            method: 'voice-band energy + 2-8 Hz syllabic modulation (heuristic, not speech recognition)',
          };
        }),
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af',
        'volumedetect,ebur128=peak=true,silencedetect=n=-45dB:d=0.6', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
          facts.analysis.loudnessLufs = lastNumber(summary, /I:\s*(-?[0-9.]+)\s*LUFS/g);
          facts.analysis.truePeakDb = lastNumber(summary, /Peak:\s*(-?[0-9.inf]+)\s*dBFS/g);
          facts.analysis.meanVolumeDb = lastNumber(stderr, /mean_volume:\s*(-?[0-9.]+)\s*dB/g);
          facts.analysis.clippedSamples = lastNumber(stderr, /histogram_0db:\s*(\d+)/g) ?? 0;
          facts.analysis.silenceSegments = segments(stderr, 'silence_start', 'silence_end')
            .map((s) => ({ start: Math.max(0, s.start), end: Number.isFinite(s.end) ? s.end : durationS }));
        }),
    );
  }
  await Promise.all(jobs);
  return facts;
}
