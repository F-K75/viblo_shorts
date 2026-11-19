import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { MediaFacts } from './models.ts';

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
  if (as) {
    jobs.push(
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
