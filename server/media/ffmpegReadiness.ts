import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { MediaProviderHealth } from './provider.ts';

type MediaBinary = 'ffmpeg' | 'ffprobe';
type ProbeFailure = 'missing' | 'spawn_failed' | 'timeout' | 'output_limit' | 'bad_version' | 'nonzero_exit';

export type MediaBinaryReadiness =
  | { readonly status: 'ready'; readonly version: string }
  | { readonly status: 'unavailable'; readonly reason: ProbeFailure };

export interface FfmpegReadiness extends MediaProviderHealth {
  readonly ffmpeg: MediaBinaryReadiness;
  readonly ffprobe: MediaBinaryReadiness;
}

/** Operator-owned overrides. Request data must never supply executable paths. */
export interface FfmpegReadinessOptions {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly timeoutMs?: number;
}

const SYSTEM_BINARY_PATH = '/usr/bin:/usr/local/bin:/opt/homebrew/bin:/bin';
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;

function probeVersion(tool: MediaBinary, binary: string, timeoutMs: number): Promise<MediaBinaryReadiness> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['-version'], {
      shell: false,
      env: { PATH: SYSTEM_BINARY_PATH, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: MediaBinaryReadiness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (reason: ProbeFailure) => {
      finish({ status: 'unavailable', reason });
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const count = (chunk: Buffer) => {
      if (settled) return false;
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_OUTPUT_BYTES) return true;
      stop('output_limit');
      return false;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (count(chunk)) stdout.push(chunk);
    });
    child.stderr.on('data', count);
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ status: 'unavailable', reason: error.code === 'ENOENT' ? 'missing' : 'spawn_failed' });
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ status: 'unavailable', reason: 'nonzero_exit' });
        return;
      }
      const header = Buffer.concat(stdout).toString('utf8').split('\n', 1)[0];
      const version = header.match(new RegExp(`^${tool} version ([A-Za-z0-9.+_~:-]{1,80})(?:[ \\t\\r]|$)`))?.[1];
      finish(version ? { status: 'ready', version } : { status: 'unavailable', reason: 'bad_version' });
    });
  });
}

/** Checks binary readiness. Codec, filter and worker isolation checks belong to capability validation. */
export async function checkFfmpegReadiness(options: FfmpegReadinessOptions = {}): Promise<FfmpegReadiness> {
  const { ffmpegPath, ffprobePath, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  for (const binary of [ffmpegPath, ffprobePath]) {
    if (binary !== undefined && (!isAbsolute(binary) || binary.includes('\0'))) {
      throw new TypeError('Media binary override must be a valid absolute path');
    }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`Media binary probe timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  const [ffmpeg, ffprobe] = await Promise.all([
    probeVersion('ffmpeg', ffmpegPath ?? 'ffmpeg', timeoutMs),
    probeVersion('ffprobe', ffprobePath ?? 'ffprobe', timeoutMs),
  ]);
  return {
    status: ffmpeg.status === 'ready' && ffprobe.status === 'ready' ? 'ready' : 'unavailable',
    checkedAt: new Date().toISOString(),
    ffmpeg,
    ffprobe,
  };
}
