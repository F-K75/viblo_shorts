import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { MediaFacts } from './models.ts';

/**
 * Measures a media file with ffprobe and ffmpeg analysis filters (no shell: argument arrays only, with a timeout).
 * Automatically detects FFmpeg 4.x vs 5.x/6.x filter/option support (e.g. blurdetect, -fps_mode vs -vsync) so
 * analysis never fails silently on older FFmpeg builds.
 */

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface FfmpegCapabilities {
  hasBlurdetect: boolean;
  hasFpsMode: boolean;
  hasSignalstats: boolean;
}

const capsCache = new Map<string, FfmpegCapabilities>();

/** Probes the installed ffmpeg binary once and caches its supported options/filters. */
export function detectFfmpegCapabilities(ffmpeg = 'ffmpeg'): FfmpegCapabilities {
  const cached = capsCache.get(ffmpeg);
  if (cached) return cached;
  const filters = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 5000 });
  const filterOut = `${filters.stdout || ''}\n${filters.stderr || ''}`;
  const help = spawnSync(ffmpeg, ['-hide_banner', '-h'], { encoding: 'utf8', timeout: 5000 });
  const helpOut = `${help.stdout || ''}\n${help.stderr || ''}`;
  const caps: FfmpegCapabilities = {
    hasBlurdetect: /\bblurdetect\b/.test(filterOut),
    hasFpsMode: /-fps_mode\b/.test(helpOut),
    hasSignalstats: /\bsignalstats\b/.test(filterOut),
  };
  capsCache.set(ffmpeg, caps);
  return caps;
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
  const raw = all[all.length - 1][1];
  if (/^-?inf$/i.test(raw)) return null;
  const v = Number(raw);
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

/**
 * Computes brightness (mean luma 0..255), contrast spread (95th - 5th percentile luma), and
 * Laplacian edge sharpness score (mean abs 2nd derivative) from downscaled grayscale frames.
 * Works identically on every FFmpeg version without relying on FFmpeg 5.1+ blurdetect.
 */
export function analyzeGrayFrames(
  raw: Buffer,
  width: number,
  height: number,
): { sharpnessScore: number | null; brightnessMean: number | null; contrastSpread: number | null } {
  const frameSize = width * height;
  const numFrames = Math.floor(raw.length / frameSize);
  if (numFrames <= 0 || width < 4 || height < 4) {
    return { sharpnessScore: null, brightnessMean: null, contrastSpread: null };
  }
  let totalMean = 0;
  let totalSpread = 0;
  let totalLap = 0;
  for (let f = 0; f < numFrames; f++) {
    const off = f * frameSize;
    const hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = raw[off + i];
      sum += v;
      hist[v]++;
    }
    totalMean += sum / frameSize;
    // 5th and 95th percentile luma for robust contrast spread
    const p5Target = Math.floor(frameSize * 0.05);
    const p95Target = Math.floor(frameSize * 0.95);
    let acc = 0;
    let p5 = 0;
    let p95 = 255;
    let got5 = false;
    for (let b = 0; b < 256; b++) {
      acc += hist[b];
      if (!got5 && acc >= p5Target) {
        p5 = b;
        got5 = true;
      }
      if (acc >= p95Target) {
        p95 = b;
        break;
      }
    }
    totalSpread += p95 - p5;

    // 4-neighbor Laplacian edge magnitude mean
    let lapSum = 0;
    let lapCount = 0;
    for (let y = 1; y < height - 1; y++) {
      const row = off + y * width;
      for (let x = 1; x < width - 1; x++) {
        const c = raw[row + x];
        const lap = Math.abs(4 * c - raw[row + x - 1] - raw[row + x + 1] - raw[row - width + x] - raw[row + width + x]);
        lapSum += lap;
        lapCount++;
      }
    }
    totalLap += lapCount ? lapSum / lapCount : 0;
  }
  return {
    sharpnessScore: Math.round((totalLap / numFrames) * 100) / 100,
    brightnessMean: Math.round((totalMean / numFrames) * 10) / 10,
    contrastSpread: Math.round((totalSpread / numFrames) * 10) / 10,
  };
}

export async function probeMedia(
  file: string,
  opts: { ffprobe?: string; ffmpeg?: string; timeoutMs?: number } = {},
): Promise<MediaFacts> {
  const ffprobe = opts.ffprobe || 'ffprobe';
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const caps = detectFfmpegCapabilities(ffmpeg);

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
          bitrate: Number(vs.bit_rate) || Number(info.format?.bit_rate) || undefined,
          durationS: Number(vs.duration) || durationS,
          startTimeS: Number.isFinite(Number(vs.start_time)) ? Number(vs.start_time) : 0,
        }
      : null,
    audio: as
      ? {
          codec: String(as.codec_name || ''),
          sampleRate: Number(as.sample_rate) || 0,
          channels: Number(as.channels) || 0,
          durationS: Number(as.duration) || durationS,
          bitrate: Number(as.bit_rate) || undefined,
          startTimeS: Number.isFinite(Number(as.start_time)) ? Number(as.start_time) : 0,
        }
      : null,
    analysis: {
      blurMean: null,
      sharpnessScore: null,
      brightnessMean: null,
      contrastSpread: null,
      blackSegments: [],
      freezeSegments: [],
      sceneCuts: [],
      effectiveFps: null,
      loudnessLufs: null,
      truePeakDb: null,
      meanVolumeDb: null,
      maxVolumeDb: null,
      rmsDb: null,
      speechBandMeanDb: null,
      clippedSamples: null,
      silenceSegments: [],
      frameHashes: [],
    },
  };

  const jobs: Promise<void>[] = [];
  if (vs) {
    // Core visual analysis on a downscaled 10 fps copy: black, freeze and scene-cut detection.
    // Only include blurdetect when supported by the installed FFmpeg build (FFmpeg 5.1+); never break the chain on 4.x!
    const vfParts = [
      'fps=10',
      'scale=360:-2',
      ...(caps.hasBlurdetect ? ['blurdetect'] : []),
      'blackdetect=d=0.3:pix_th=0.10',
      'freezedetect=n=0.003:d=1',
      'scdet=t=12:s=1',
    ];
    jobs.push(
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', vfParts.join(','), '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          facts.analysis.blurMean = lastNumber(stderr, /blur mean:\s*([0-9.]+)/g);
          facts.analysis.blackSegments = segments(stderr, 'black_start', 'black_end')
            .map((s) => ({ start: s.start, end: Number.isFinite(s.end) ? s.end : durationS }));
          facts.analysis.freezeSegments = segments(stderr, 'freeze_start', 'freeze_end')
            .map((s) => ({ start: s.start, end: Number.isFinite(s.end) ? s.end : durationS }));
          facts.analysis.sceneCuts = [...stderr.matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)]
            .map((m) => Number(m[1]))
            .filter((t) => t > 0.05);
        }),
      // Distinct frames: mpdecimate drops frames that repeat the previous one (dropped/duplicated encoder frames).
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', 'scale=270:-2,mpdecimate', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          const kept = lastNumber(stderr, /frame=\s*(\d+)/g);
          facts.analysis.effectiveFps = kept !== null && durationS > 0 ? Math.round((kept / durationS) * 10) / 10 : null;
        }),
      // Perceptual dHash at 1 fps (9x8 gray) for repetition detection.
      run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', 'fps=1,scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'], timeoutMs)
        .then(({ stdout }) => {
          facts.analysis.frameHashes = dHashFrames(stdout);
        }),
      // Brightness, contrast, and Laplacian edge sharpness at 1 fps (90x160 gray) — version-independent.
      run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', 'fps=1,scale=90:160:flags=area,format=gray', '-f', 'rawvideo', '-'], timeoutMs)
        .then(({ stdout }) => {
          const stats = analyzeGrayFrames(stdout, 90, 160);
          facts.analysis.sharpnessScore = stats.sharpnessScore;
          facts.analysis.brightnessMean = stats.brightnessMean;
          facts.analysis.contrastSpread = stats.contrastSpread;
        }),
    );
  }
  if (as) {
    jobs.push(
      // Full-band audio waveform analysis: volumedetect (mean/max/clipping), ebur128 (LUFS/true peak), astats (RMS), silencedetect.
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af',
        'volumedetect,ebur128=peak=true,astats=metadata=0:reset=0,silencedetect=n=-45dB:d=0.6', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          const summaryIdx = stderr.lastIndexOf('Summary:');
          const summary = summaryIdx >= 0 ? stderr.slice(summaryIdx) : stderr;
          facts.analysis.loudnessLufs = lastNumber(summary, /I:\s*(-?[0-9.]+)\s*LUFS/g);
          facts.analysis.truePeakDb = lastNumber(summary, /Peak:\s*(-?[0-9.inf]+)\s*dBFS/g);
          facts.analysis.meanVolumeDb = lastNumber(stderr, /mean_volume:\s*(-?[0-9.]+)\s*dB/g);
          facts.analysis.maxVolumeDb = lastNumber(stderr, /max_volume:\s*(-?[0-9.]+)\s*dB/g);
          const overallIdx = stderr.lastIndexOf('Overall');
          const overall = overallIdx >= 0 ? stderr.slice(overallIdx) : stderr;
          facts.analysis.rmsDb = lastNumber(overall, /RMS level dB:\s*(-?[0-9.inf]+)/g) ?? facts.analysis.meanVolumeDb;
          facts.analysis.clippedSamples = lastNumber(stderr, /histogram_0db:\s*(\d+)/g) ?? 0;
          facts.analysis.silenceSegments = segments(stderr, 'silence_start', 'silence_end')
            .map((s) => ({ start: Math.max(0, s.start), end: Number.isFinite(s.end) ? s.end : durationS }));
        }),
      // Human voice frequency band (300–3400 Hz) energy check to verify speech/vocal presence vs dead silence or rumble.
      run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af',
        'highpass=f=300,lowpass=f=3400,volumedetect', '-f', 'null', '-'], timeoutMs)
        .then(({ stderr }) => {
          facts.analysis.speechBandMeanDb = lastNumber(stderr, /mean_volume:\s*(-?[0-9.]+)\s*dB/g);
        }),
    );
  }
  await Promise.all(jobs);
  return facts;
}
