import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import type { BuiltFfmpegCommand } from './commandBuilder.ts';
import { buildCleanSubprocessEnv, redactFilesystemPaths, type MediaEngineConfig } from './config.ts';
import { classifyMediaError, MediaEngineError } from './exceptions.ts';

export interface ExecutionOptions {
  jobId: string;
  expectedDurationSeconds?: number;
  timeoutMs?: number;
  onProgress?: (percent: number, currentTimeSeconds: number) => void;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  outputPath: string;
  sizeBytes: number;
  elapsedMs: number;
  stderrTail: string;
}

function parseOutTimeSeconds(stderrChunk: string): number | null {
  const matches = [...stderrChunk.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/**
 * Isolated argument-array FFmpeg subprocess executor (`shell: false`).
 * Uses scrubbed environment (`buildCleanSubprocessEnv`), redacts host paths from error strings,
 * tracks active PIDs by jobId for instant `SIGKILL` cancellation, and cleans up partial outputs.
 */
export class FfmpegExecutor {
  private readonly activeProcesses = new Map<string, ChildProcess>();

  constructor(private readonly config: MediaEngineConfig) {}

  get runningCount(): number {
    return this.activeProcesses.size;
  }

  computeTimeoutMs(durationSeconds = 15): number {
    const scaled = Math.ceil(Math.max(1, durationSeconds) * this.config.renderTimeoutFactor * 1000);
    return Math.min(this.config.renderTimeoutMaxMs, Math.max(this.config.renderTimeoutMinMs, scaled));
  }

  cancel(jobId: string): boolean {
    const proc = this.activeProcesses.get(jobId);
    if (!proc) return false;
    proc.kill('SIGKILL');
    this.activeProcesses.delete(jobId);
    return true;
  }

  cancelAll(): string[] {
    const ids = [...this.activeProcesses.keys()];
    for (const proc of this.activeProcesses.values()) {
      proc.kill('SIGKILL');
    }
    this.activeProcesses.clear();
    return ids;
  }

  async execute(cmd: BuiltFfmpegCommand, opts: ExecutionOptions): Promise<ExecutionResult> {
    if (opts.signal?.aborted) {
      throw new MediaEngineError('RENDER_TIMEOUT', 'Render cancelled before execution started', { recoverable: false });
    }
    const timeoutMs = opts.timeoutMs ?? this.computeTimeoutMs(opts.expectedDurationSeconds);
    const startedAt = Date.now();

    return new Promise<ExecutionResult>((resolve, reject) => {
      const proc = spawn(cmd.binary, cmd.args, {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildCleanSubprocessEnv(),
      });

      this.activeProcesses.set(opts.jobId, proc);
      let stderrTail = '';
      let timedOut = false;
      let aborted = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        proc.kill('SIGKILL');
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-6000);
        if (opts.onProgress && opts.expectedDurationSeconds && opts.expectedDurationSeconds > 0) {
          const curSec = parseOutTimeSeconds(text);
          if (curSec !== null) {
            const pct = Math.min(99, Math.max(1, Math.round((curSec / opts.expectedDurationSeconds) * 100)));
            opts.onProgress(pct, curSec);
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.activeProcesses.delete(opts.jobId);
        fs.rmSync(cmd.outputPath, { force: true });
        reject(classifyMediaError(new Error(redactFilesystemPaths(err.message)), 'STORAGE_ERROR'));
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.activeProcesses.delete(opts.jobId);

        if (timedOut) {
          fs.rmSync(cmd.outputPath, { force: true });
          return reject(
            new MediaEngineError('RENDER_TIMEOUT', `FFmpeg render timed out after ${Math.round(timeoutMs / 1000)}s`),
          );
        }
        if (aborted || signal === 'SIGKILL' || signal === 'SIGTERM') {
          fs.rmSync(cmd.outputPath, { force: true });
          return reject(
            new MediaEngineError('RENDER_TIMEOUT', `Render cancelled (${signal || 'aborted'})`, { recoverable: false }),
          );
        }
        if (code !== 0) {
          fs.rmSync(cmd.outputPath, { force: true });
          return reject(
            classifyMediaError(
              new Error(`FFmpeg exited with code ${code}: ${redactFilesystemPaths(stderrTail).slice(-260)}`),
              'FILTER_ERROR',
            ),
          );
        }

        try {
          const st = fs.statSync(cmd.outputPath);
          if (!st.isFile() || st.size < 128) {
            fs.rmSync(cmd.outputPath, { force: true });
            return reject(new MediaEngineError('OUTPUT_CORRUPTION', 'Rendered output file is empty or truncated'));
          }
          opts.onProgress?.(100, opts.expectedDurationSeconds ?? 0);
          resolve({
            outputPath: cmd.outputPath,
            sizeBytes: st.size,
            elapsedMs: Date.now() - startedAt,
            stderrTail,
          });
        } catch (err) {
          reject(new MediaEngineError('OUTPUT_CORRUPTION', 'Rendered output file missing after FFmpeg exit 0', { cause: err }));
        }
      });
    });
  }
}
