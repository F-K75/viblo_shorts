import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export const ALLOWED_EXPORT_CONTAINERS = ['mp4', 'mov', 'mkv', 'mp3', 'jpg'] as const;
export const ALLOWED_EXPORT_VIDEO_CODECS = ['libx264', 'libx265', 'copy'] as const;
export const ALLOWED_EXPORT_AUDIO_CODECS = ['aac', 'libmp3lame', 'copy'] as const;
export const ALLOWED_PIXEL_FORMATS = ['yuv420p'] as const;
export const ALLOWED_INPUT_VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mjpeg', 'png', 'webp', 'gif'] as const;
export const ALLOWED_INPUT_AUDIO_CODECS = ['aac', 'mp3', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'opus', 'vorbis', 'flac'] as const;
export const ALLOWED_TRANSITIONS = ['none', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideup', 'slidedown'] as const;

export type ExportContainer = (typeof ALLOWED_EXPORT_CONTAINERS)[number];
export type ExportVideoCodec = (typeof ALLOWED_EXPORT_VIDEO_CODECS)[number];
export type ExportAudioCodec = (typeof ALLOWED_EXPORT_AUDIO_CODECS)[number];
export type ExportPixelFormat = (typeof ALLOWED_PIXEL_FORMATS)[number];
export type TransitionKind = (typeof ALLOWED_TRANSITIONS)[number];

export interface MediaEngineConfig {
  ffmpegBin: string;
  ffprobeBin: string | null;
  dataDir: string;
  bundledFontPath: string | null;
  protocolWhitelist: string;
  maxThreads: number;
  maxConcurrentProbes: number;
  maxDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxClipsPerTrack: number;
  maxAudioTracks: number;
  maxSubtitleCues: number;
  maxAssetBytes: number;
  maxTenantBytes: number;
  probeTimeoutMs: number;
  renderTimeoutFactor: number;
  renderTimeoutMinMs: number;
  renderTimeoutMaxMs: number;
  qaTimeoutMs: number;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region: string;
  s3Endpoint?: string;
}

// Only trusted system-installed paths; never search world-writable /tmp or user directories automatically.
const SYSTEM_FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
const SYSTEM_FFPROBE_CANDIDATES = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'];

/**
 * Scrubbed subprocess environment so application secrets (`SESSION_SECRET`, `DATABASE_URL`,
 * `GEMINI_API_KEY`, AWS credentials, etc.) are NEVER inherited by `ffmpeg` or `ffprobe` processes.
 */
export function buildCleanSubprocessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
  };
}

/**
 * Redacts absolute host filesystem paths from FFmpeg/FFprobe diagnostic stderr slices
 * before surfacing error messages to API callers.
 */
export function redactFilesystemPaths(raw: string): string {
  return String(raw || '')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '<media-path>')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRunnableBinary(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    execFileSync(bin, ['-version'], {
      stdio: 'ignore',
      timeout: 3000,
      env: buildCleanSubprocessEnv(env),
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveFfmpegBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FFMPEG_PATH && env.FFMPEG_PATH.trim()) {
    return env.FFMPEG_PATH.trim();
  }
  if (isRunnableBinary('ffmpeg', env)) return 'ffmpeg';
  for (const candidate of SYSTEM_FFMPEG_CANDIDATES) {
    if (fs.existsSync(candidate) && isRunnableBinary(candidate, env)) {
      return candidate;
    }
  }
  return 'ffmpeg';
}

export function resolveFfprobeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.FFPROBE_PATH && env.FFPROBE_PATH.trim()) {
    const custom = env.FFPROBE_PATH.trim();
    return isRunnableBinary(custom, env) ? custom : null;
  }
  if (isRunnableBinary('ffprobe', env)) return 'ffprobe';
  for (const candidate of SYSTEM_FFPROBE_CANDIDATES) {
    if (fs.existsSync(candidate) && isRunnableBinary(candidate, env)) {
      return candidate;
    }
  }
  return null;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function createMediaEngineConfig(
  overrides: Partial<MediaEngineConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): MediaEngineConfig {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const defaultFont = path.join(repoRoot, 'assets', 'fonts', 'Poppins-Bold.ttf');
  const dataDir = overrides.dataDir ?? (env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, 'data'));

  return {
    ffmpegBin: overrides.ffmpegBin ?? resolveFfmpegBinary(env),
    ffprobeBin: overrides.ffprobeBin !== undefined ? overrides.ffprobeBin : resolveFfprobeBinary(env),
    dataDir,
    bundledFontPath:
      overrides.bundledFontPath !== undefined
        ? overrides.bundledFontPath
        : fs.existsSync(defaultFont)
          ? defaultFont
          : null,
    // Security control: block network/SSRF protocols (http, https, tcp, concat, subfile) on every input.
    protocolWhitelist: overrides.protocolWhitelist ?? 'file,pipe',
    maxThreads: overrides.maxThreads ?? envInt(env, 'MEDIA_MAX_THREADS', 2, 1, 16),
    maxConcurrentProbes: overrides.maxConcurrentProbes ?? envInt(env, 'MEDIA_MAX_CONCURRENT_PROBES', 4, 1, 32),
    maxDurationSeconds: overrides.maxDurationSeconds ?? envInt(env, 'MEDIA_MAX_DURATION_S', 300, 1, 3600),
    maxWidth: overrides.maxWidth ?? envInt(env, 'MEDIA_MAX_WIDTH', 3840, 128, 7680),
    maxHeight: overrides.maxHeight ?? envInt(env, 'MEDIA_MAX_HEIGHT', 3840, 128, 7680),
    maxFps: overrides.maxFps ?? envInt(env, 'MEDIA_MAX_FPS', 60, 1, 120),
    maxClipsPerTrack: overrides.maxClipsPerTrack ?? 64,
    maxAudioTracks: overrides.maxAudioTracks ?? 16,
    maxSubtitleCues: overrides.maxSubtitleCues ?? 500,
    maxAssetBytes: overrides.maxAssetBytes ?? envInt(env, 'MEDIA_MAX_ASSET_BYTES', 250 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
    maxTenantBytes: overrides.maxTenantBytes ?? envInt(env, 'MEDIA_MAX_TENANT_BYTES', 2 * 1024 * 1024 * 1024, 1024 * 1024, 50 * 1024 * 1024 * 1024),
    probeTimeoutMs: overrides.probeTimeoutMs ?? envInt(env, 'MEDIA_PROBE_TIMEOUT_MS', 15_000, 1_000, 120_000),
    renderTimeoutFactor: overrides.renderTimeoutFactor ?? 4,
    renderTimeoutMinMs: overrides.renderTimeoutMinMs ?? envInt(env, 'MEDIA_RENDER_TIMEOUT_MIN_MS', 30_000, 2_000, 600_000),
    renderTimeoutMaxMs: overrides.renderTimeoutMaxMs ?? envInt(env, 'MEDIA_RENDER_TIMEOUT_MAX_MS', 600_000, 5_000, 3_600_000),
    qaTimeoutMs: overrides.qaTimeoutMs ?? envInt(env, 'MEDIA_QA_TIMEOUT_MS', 60_000, 2_000, 300_000),
    s3Bucket: overrides.s3Bucket ?? (env.MEDIA_S3_BUCKET || undefined),
    s3Prefix: overrides.s3Prefix ?? (env.MEDIA_S3_PREFIX || 'forge-media'),
    s3Region: overrides.s3Region ?? (env.S3_REGION || env.AWS_REGION || 'us-east-1'),
    s3Endpoint: overrides.s3Endpoint ?? (env.S3_ENDPOINT || undefined),
  };
}
