import fs from 'fs';
import { spawn } from 'child_process';
import {
  ALLOWED_INPUT_AUDIO_CODECS,
  ALLOWED_INPUT_VIDEO_CODECS,
  buildCleanSubprocessEnv,
  redactFilesystemPaths,
  type MediaEngineConfig,
} from './config.ts';
import { MediaEngineError } from './exceptions.ts';
import type {
  AudioStreamInfo,
  MediaAssetKind,
  MediaAssetRecord,
  MediaManifest,
  SubtitleStreamInfo,
  TimelineSubtitleCue,
  VideoStreamInfo,
} from './models.ts';
import type { MediaStorage } from './storage.ts';

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcessSafe(bin: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCleanSubprocessEnv(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 512_000) stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 256_000) stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function computeAspectRatio(width: number, height: number): string {
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

function parseFraction(raw: string | undefined): number {
  if (!raw) return 0;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseTimestampSeconds(hms: string): number {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(hms.trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Parses and validates SRT or WebVTT subtitle files into normalized cues.
 */
export function parseSubtitleText(content: string): { format: 'srt' | 'vtt'; cues: TimelineSubtitleCue[]; durationSeconds: number } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    throw new MediaEngineError('PROBE_ERROR', 'Subtitle file is empty');
  }
  const isVtt = normalized.startsWith('WEBVTT');
  const blocks = normalized.split(/\n{2,}/);
  const cues: TimelineSubtitleCue[] = [];
  const timeRe = /^(\d{1,2}:\d{2}:\d{2}[,.]\d{3}|\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3}|\d{2}:\d{2}[,.]\d{3})/;

  const toSec = (raw: string): number => {
    const clean = raw.replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    }
    return Number(parts[0]) * 60 + Number(parts[1]);
  };

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) continue;
    let timeLineIdx = 0;
    if (!timeRe.test(lines[0]) && lines.length > 1 && timeRe.test(lines[1])) {
      timeLineIdx = 1;
    }
    const match = timeRe.exec(lines[timeLineIdx]);
    if (!match) continue;
    const start = toSec(match[1]);
    const end = toSec(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new MediaEngineError('PROBE_ERROR', `Invalid subtitle timestamp range: ${lines[timeLineIdx]}`);
    }
    const text = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) {
      cues.push({ start, end, text });
    }
  }

  if (cues.length === 0) {
    throw new MediaEngineError('PROBE_ERROR', 'No valid subtitle cues found in subtitle file');
  }
  const maxEnd = cues.reduce((acc, c) => Math.max(acc, c.end), 0);
  return { format: isVtt ? 'vtt' : 'srt', cues, durationSeconds: maxEnd };
}

/**
 * Inspects media files using FFprobe (preferred) or FFmpeg stream parser fallback + decode sanity check.
 * Enforces bounded subprocess concurrency (`maxConcurrentProbes`), scrubbed child environment, and path redaction.
 */
export class MediaProbe {
  private activeProbes = 0;
  private readonly probeWaiters: Array<() => void> = [];

  constructor(
    private readonly config: MediaEngineConfig,
    private readonly storage?: MediaStorage,
  ) {}

  private async withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeProbes >= this.config.maxConcurrentProbes) {
      await new Promise<void>((resolve) => this.probeWaiters.push(resolve));
    }
    this.activeProbes++;
    try {
      return await fn();
    } finally {
      this.activeProbes--;
      const next = this.probeWaiters.shift();
      if (next) next();
    }
  }

  async inspect(asset: MediaAssetRecord, requestingTenantId: string): Promise<MediaManifest> {
    if (!this.storage) {
      throw new MediaEngineError('STORAGE_ERROR', 'MediaStorage instance required to inspect by asset record');
    }
    const localPath = await this.storage.resolveAuthorizedAssetPath(asset, requestingTenantId);
    return this.inspectFile(localPath, asset.id, asset.kind);
  }

  async inspectFile(filePath: string, assetId = 'asset_local', declaredKind?: MediaAssetKind): Promise<MediaManifest> {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      throw new MediaEngineError('ASSET_ERROR', `Media file does not exist: ${assetId}`, { httpStatus: 404 });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MediaEngineError('ASSET_ERROR', 'Media target must be a regular non-symlink file');
    }
    if (stat.size === 0) {
      throw new MediaEngineError('PROBE_ERROR', 'Media file is empty (0 bytes)');
    }

    if (declaredKind === 'subtitle' || /\.(srt|vtt)$/i.test(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseSubtitleText(raw);
      return {
        assetId,
        kind: 'subtitle',
        formatName: parsed.format,
        durationSeconds: parsed.durationSeconds,
        sizeBytes: stat.size,
        hasVideo: false,
        hasAudio: false,
        width: null,
        height: null,
        fps: null,
        aspectRatio: null,
        videoCodec: null,
        audioCodec: null,
        pixelFormat: null,
        isVariableFps: false,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [{ index: 0, codec: parsed.format, cueCount: parsed.cues.length }],
        warnings: [],
        probedBy: 'subtitle_parser',
        probedAt: new Date().toISOString(),
      };
    }

    return this.withProbeSlot(async () => {
      const manifest = this.config.ffprobeBin
        ? await this.inspectViaFfprobe(filePath, assetId, stat.size, declaredKind)
        : await this.inspectViaFfmpeg(filePath, assetId, stat.size, declaredKind);

      // Lightweight 0.5-second decode integrity check so truncated/corrupted payloads are caught at probe time.
      await this.verifyDecodeIntegrity(filePath);

      return manifest;
    });
  }

  private async verifyDecodeIntegrity(filePath: string): Promise<void> {
    const res = await runProcessSafe(
      this.config.ffmpegBin,
      [
        '-nostdin',
        '-v',
        'error',
        '-xerror',
        '-threads',
        String(this.config.maxThreads),
        '-protocol_whitelist',
        this.config.protocolWhitelist,
        '-i',
        filePath,
        '-t',
        '0.5',
        '-f',
        'null',
        '-',
      ],
      this.config.probeTimeoutMs,
    );
    if (res.timedOut) {
      throw new MediaEngineError('RENDER_TIMEOUT', 'Media decode integrity check timed out');
    }
    if (res.code !== 0) {
      throw new MediaEngineError(
        'PROBE_ERROR',
        `Corrupted or unreadable media stream: ${redactFilesystemPaths(res.stderr).slice(0, 240) || `exit ${res.code}`}`,
      );
    }
  }

  private async inspectViaFfprobe(
    filePath: string,
    assetId: string,
    sizeBytes: number,
    declaredKind?: MediaAssetKind,
  ): Promise<MediaManifest> {
    const res = await runProcessSafe(
      this.config.ffprobeBin!,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        this.config.protocolWhitelist,
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        filePath,
      ],
      this.config.probeTimeoutMs,
    );
    if (res.timedOut) {
      throw new MediaEngineError('RENDER_TIMEOUT', 'FFprobe inspection timed out');
    }
    if (res.code !== 0) {
      throw new MediaEngineError('PROBE_ERROR', `FFprobe failed: ${redactFilesystemPaths(res.stderr).slice(0, 240)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch (err) {
      throw new MediaEngineError('PROBE_ERROR', 'FFprobe returned invalid JSON', { cause: err });
    }

    const streams = Array.isArray(parsed.streams) ? (parsed.streams as Array<Record<string, unknown>>) : [];
    const format = (parsed.format ?? {}) as Record<string, unknown>;

    const videoStreams: VideoStreamInfo[] = [];
    const audioStreams: AudioStreamInfo[] = [];
    const subtitleStreams: SubtitleStreamInfo[] = [];
    const warnings: string[] = [];

    for (const s of streams) {
      const codecType = String(s.codec_type || '');
      const codec = String(s.codec_name || 'unknown').toLowerCase();
      const index = Number(s.index ?? 0);

      if (codecType === 'video') {
        const width = Number(s.width ?? 0);
        const height = Number(s.height ?? 0);
        const nominalFps = parseFraction(String(s.r_frame_rate || '0/1'));
        const avgFps = parseFraction(String(s.avg_frame_rate || '0/1'));
        const fps = avgFps > 0 ? avgFps : nominalFps;
        const isVariableFps =
          nominalFps > 0 && avgFps > 0 && Math.abs(nominalFps - avgFps) / Math.max(nominalFps, avgFps) > 0.05;
        if (isVariableFps) {
          warnings.push(`Variable frame rate detected (nominal ${nominalFps.toFixed(2)} fps vs avg ${avgFps.toFixed(2)} fps)`);
        }
        if (!(ALLOWED_INPUT_VIDEO_CODECS as readonly string[]).includes(codec)) {
          throw new MediaEngineError('UNSUPPORTED_CODEC', `Unsupported input video codec: ${codec}`);
        }
        videoStreams.push({
          index,
          codec,
          ...(typeof s.profile === 'string' ? { profile: s.profile } : {}),
          width,
          height,
          pixelFormat: String(s.pix_fmt || 'unknown'),
          fps: Number(fps.toFixed(3)),
          nominalFps: Number(nominalFps.toFixed(3)),
          avgFps: Number(avgFps.toFixed(3)),
          isVariableFps,
          aspectRatio:
            typeof s.display_aspect_ratio === 'string' && s.display_aspect_ratio !== '0:1'
              ? s.display_aspect_ratio
              : width > 0 && height > 0
                ? computeAspectRatio(width, height)
                : '0:0',
          ...(s.duration !== undefined ? { durationSeconds: Number(s.duration) } : {}),
          ...(s.bit_rate !== undefined ? { bitRate: Number(s.bit_rate) } : {}),
        });
      } else if (codecType === 'audio') {
        if (!(ALLOWED_INPUT_AUDIO_CODECS as readonly string[]).includes(codec)) {
          throw new MediaEngineError('UNSUPPORTED_CODEC', `Unsupported input audio codec: ${codec}`);
        }
        audioStreams.push({
          index,
          codec,
          sampleRate: Number(s.sample_rate ?? 0),
          channels: Number(s.channels ?? 0),
          ...(typeof s.channel_layout === 'string' ? { channelLayout: s.channel_layout } : {}),
          ...(s.duration !== undefined ? { durationSeconds: Number(s.duration) } : {}),
          ...(s.bit_rate !== undefined ? { bitRate: Number(s.bit_rate) } : {}),
        });
      } else if (codecType === 'subtitle') {
        const tags = (s.tags ?? {}) as Record<string, unknown>;
        subtitleStreams.push({
          index,
          codec,
          ...(typeof tags.language === 'string' ? { language: tags.language } : {}),
        });
      }
    }

    if (videoStreams.length === 0 && audioStreams.length === 0 && subtitleStreams.length === 0) {
      throw new MediaEngineError('PROBE_ERROR', 'No decodable video, audio, or subtitle streams found');
    }

    const durationSeconds = Math.max(
      0,
      Number(format.duration ?? videoStreams[0]?.durationSeconds ?? audioStreams[0]?.durationSeconds ?? 0),
    );
    const primaryVideo = videoStreams[0];
    const primaryAudio = audioStreams[0];
    if (primaryVideo && !primaryAudio && declaredKind !== 'image') {
      warnings.push('Video asset contains no audio stream');
    }

    const inferredKind: MediaAssetKind =
      declaredKind ??
      (primaryVideo
        ? durationSeconds <= 0.1 && ['png', 'mjpeg', 'webp'].includes(primaryVideo.codec)
          ? 'image'
          : 'video'
        : primaryAudio
          ? 'audio'
          : 'subtitle');

    return {
      assetId,
      kind: inferredKind,
      formatName: String(format.format_name || 'unknown'),
      durationSeconds: Number(durationSeconds.toFixed(3)),
      sizeBytes,
      ...(format.bit_rate !== undefined ? { bitRate: Number(format.bit_rate) } : {}),
      hasVideo: videoStreams.length > 0,
      hasAudio: audioStreams.length > 0,
      width: primaryVideo ? primaryVideo.width : null,
      height: primaryVideo ? primaryVideo.height : null,
      fps: primaryVideo ? primaryVideo.fps : null,
      aspectRatio: primaryVideo ? primaryVideo.aspectRatio : null,
      videoCodec: primaryVideo ? primaryVideo.codec : null,
      audioCodec: primaryAudio ? primaryAudio.codec : null,
      pixelFormat: primaryVideo ? primaryVideo.pixelFormat : null,
      isVariableFps: Boolean(primaryVideo?.isVariableFps),
      videoStreams,
      audioStreams,
      subtitleStreams,
      warnings,
      probedBy: 'ffprobe',
      probedAt: new Date().toISOString(),
    };
  }

  private async inspectViaFfmpeg(
    filePath: string,
    assetId: string,
    sizeBytes: number,
    declaredKind?: MediaAssetKind,
  ): Promise<MediaManifest> {
    const res = await runProcessSafe(
      this.config.ffmpegBin,
      [
        '-nostdin',
        '-hide_banner',
        '-threads',
        String(this.config.maxThreads),
        '-protocol_whitelist',
        this.config.protocolWhitelist,
        '-i',
        filePath,
      ],
      this.config.probeTimeoutMs,
    );
    if (res.timedOut) {
      throw new MediaEngineError('RENDER_TIMEOUT', 'FFmpeg metadata inspection timed out');
    }
    const info = res.stderr;
    const inputHeaderMatch = /Input #0,\s*([^,]+(?:,[^,]+)*),\s*from\s*'/m.exec(info);
    if (!inputHeaderMatch) {
      throw new MediaEngineError(
        'PROBE_ERROR',
        `Unable to read media container metadata: ${redactFilesystemPaths(info).slice(0, 220) || 'unrecognized format'}`,
      );
    }
    const formatName = inputHeaderMatch[1].trim();
    const durMatch = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/m.exec(info);
    const bitRateMatch = /bitrate:\s*(\d+)\s*kb\/s/m.exec(info);
    const durationSeconds = durMatch ? parseTimestampSeconds(durMatch[1]) : 0;
    const bitRate = bitRateMatch ? Number(bitRateMatch[1]) * 1000 : undefined;

    const videoStreams: VideoStreamInfo[] = [];
    const audioStreams: AudioStreamInfo[] = [];
    const subtitleStreams: SubtitleStreamInfo[] = [];
    const warnings: string[] = [];

    const streamLines = info.split('\n').filter((line) => /^\s*Stream #0:\d+/.test(line));
    for (const line of streamLines) {
      const idxMatch = /Stream #0:(\d+)/.exec(line);
      const index = idxMatch ? Number(idxMatch[1]) : 0;

      if (line.includes('Video:')) {
        const afterVideo = line.split('Video:')[1]?.trim() || '';
        const codecRaw = afterVideo.split(/[\s,(]/)[0]?.toLowerCase() || 'unknown';
        if (!(ALLOWED_INPUT_VIDEO_CODECS as readonly string[]).includes(codecRaw)) {
          throw new MediaEngineError('UNSUPPORTED_CODEC', `Unsupported input video codec: ${codecRaw}`);
        }
        const dimMatch = /(\d{2,5})x(\d{2,5})/.exec(afterVideo);
        const width = dimMatch ? Number(dimMatch[1]) : 0;
        const height = dimMatch ? Number(dimMatch[2]) : 0;
        const pixMatch = /Video:\s*[^,]+,\s*([a-z0-9_]+)/i.exec(line);
        const pixelFormat = pixMatch ? pixMatch[1].toLowerCase() : 'yuv420p';
        const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(afterVideo);
        const tbrMatch = /(\d+(?:\.\d+)?)\s*tbr/.exec(afterVideo);
        const avgFps = fpsMatch ? Number(fpsMatch[1]) : tbrMatch ? Number(tbrMatch[1]) : 30;
        const nominalFps = tbrMatch ? Number(tbrMatch[1]) : avgFps;
        let isVariableFps =
          nominalFps > 0 && avgFps > 0 && Math.abs(nominalFps - avgFps) / Math.max(nominalFps, avgFps) > 0.05;

        if (!isVariableFps && durationSeconds > 0.4) {
          isVariableFps = await this.detectVariableFrameRateViaShowinfo(filePath);
        }
        if (isVariableFps) {
          warnings.push('Variable frame rate detected');
        }

        videoStreams.push({
          index,
          codec: codecRaw,
          width,
          height,
          pixelFormat,
          fps: Number(avgFps.toFixed(3)),
          nominalFps: Number(nominalFps.toFixed(3)),
          avgFps: Number(avgFps.toFixed(3)),
          isVariableFps,
          aspectRatio: width > 0 && height > 0 ? computeAspectRatio(width, height) : '0:0',
          durationSeconds,
        });
      } else if (line.includes('Audio:')) {
        const afterAudio = line.split('Audio:')[1]?.trim() || '';
        const codecRaw = afterAudio.split(/[\s,(]/)[0]?.toLowerCase() || 'unknown';
        if (!(ALLOWED_INPUT_AUDIO_CODECS as readonly string[]).includes(codecRaw)) {
          throw new MediaEngineError('UNSUPPORTED_CODEC', `Unsupported input audio codec: ${codecRaw}`);
        }
        const srMatch = /(\d+)\s*Hz/.exec(afterAudio);
        const sampleRate = srMatch ? Number(srMatch[1]) : 44100;
        const channels = /\bmono\b/i.test(afterAudio) ? 1 : /\b5\.1\b/.test(afterAudio) ? 6 : 2;
        audioStreams.push({
          index,
          codec: codecRaw,
          sampleRate,
          channels,
          durationSeconds,
        });
      } else if (line.includes('Subtitle:')) {
        const afterSub = line.split('Subtitle:')[1]?.trim() || '';
        const codecRaw = afterSub.split(/[\s,(]/)[0]?.toLowerCase() || 'subrip';
        subtitleStreams.push({ index, codecRaw } as unknown as SubtitleStreamInfo);
        subtitleStreams[subtitleStreams.length - 1] = { index, codec: codecRaw };
      }
    }

    if (videoStreams.length === 0 && audioStreams.length === 0 && subtitleStreams.length === 0) {
      throw new MediaEngineError('PROBE_ERROR', 'No decodable streams found in media asset');
    }

    const primaryVideo = videoStreams[0];
    const primaryAudio = audioStreams[0];
    if (primaryVideo && !primaryAudio && declaredKind !== 'image') {
      warnings.push('Video asset contains no audio stream');
    }

    const inferredKind: MediaAssetKind =
      declaredKind ??
      (primaryVideo
        ? durationSeconds <= 0.1 && ['png', 'mjpeg', 'webp'].includes(primaryVideo.codec)
          ? 'image'
          : 'video'
        : primaryAudio
          ? 'audio'
          : 'subtitle');

    return {
      assetId,
      kind: inferredKind,
      formatName,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      sizeBytes,
      ...(bitRate !== undefined ? { bitRate } : {}),
      hasVideo: videoStreams.length > 0,
      hasAudio: audioStreams.length > 0,
      width: primaryVideo ? primaryVideo.width : null,
      height: primaryVideo ? primaryVideo.height : null,
      fps: primaryVideo ? primaryVideo.fps : null,
      aspectRatio: primaryVideo ? primaryVideo.aspectRatio : null,
      videoCodec: primaryVideo ? primaryVideo.codec : null,
      audioCodec: primaryAudio ? primaryAudio.codec : null,
      pixelFormat: primaryVideo ? primaryVideo.pixelFormat : null,
      isVariableFps: Boolean(primaryVideo?.isVariableFps),
      videoStreams,
      audioStreams,
      subtitleStreams,
      warnings,
      probedBy: 'ffmpeg',
      probedAt: new Date().toISOString(),
    };
  }

  private async detectVariableFrameRateViaShowinfo(filePath: string): Promise<boolean> {
    const res = await runProcessSafe(
      this.config.ffmpegBin,
      [
        '-nostdin',
        '-threads',
        String(this.config.maxThreads),
        '-protocol_whitelist',
        this.config.protocolWhitelist,
        '-i',
        filePath,
        '-t',
        '1.5',
        '-vf',
        'showinfo',
        '-an',
        '-f',
        'null',
        '-',
      ],
      this.config.probeTimeoutMs,
    );
    const ptsTimes: number[] = [];
    const re = /pts_time:([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.stderr)) !== null) {
      const t = Number(m[1]);
      if (Number.isFinite(t)) ptsTimes.push(t);
    }
    if (ptsTimes.length < 5) return false;
    const deltas: number[] = [];
    for (let i = 1; i < ptsTimes.length; i++) {
      const d = ptsTimes[i] - ptsTimes[i - 1];
      if (d > 0) deltas.push(d);
    }
    if (deltas.length < 4) return false;
    const minD = Math.min(...deltas);
    const maxD = Math.max(...deltas);
    return (maxD - minD) / Math.max(minD, 0.001) > 0.25;
  }
}
