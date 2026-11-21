import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Offline text-to-speech with ffmpeg's libflite source (ffmpeg is already a server dependency).
 *
 * Why it exists: when neural TTS is unavailable, the client used to fall back to the browser's speechSynthesis,
 * which plays through the speakers but is NOT capturable by the canvas recorder — the export then carried an audio
 * stream of pure zeros. A robotic but REAL, recordable voice is strictly better than a silent reel, and the UI labels
 * it as the basic offline voice. Returns 16-bit mono PCM at 24 kHz (the same format as the neural TTS response).
 */
let available: boolean | null = null;
let running = 0;
/** Bounded: at most this many synthesis processes at once (each also has a kill timeout). */
export const MAX_OFFLINE_TTS = 2;

export class OfflineTtsBusyError extends Error {}
const MAX_WAITING = 24;
const waiting: Array<() => void> = [];

export function offlineTtsAvailable(ffmpeg = 'ffmpeg'): boolean {
  if (available !== null) return available;
  try {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000 });
    available = r.status === 0 && /\bflite\b/.test(r.stdout || '');
  } catch {
    available = false;
  }
  return available;
}

/** Neural voice name → closest flite voice (female/male). */
const VOICES: Record<string, string> = { Kore: 'slt', Zephyr: 'slt', Puck: 'rms', Charon: 'kal', Fenrir: 'awb' };

export async function synthesizeOffline(text: string, voice: string, opts: { ffmpeg?: string; timeoutMs?: number; sampleRate?: number } = {}): Promise<{ pcm: Buffer; sampleRate: number; voice: string }> {
  // Bounded: at most MAX_OFFLINE_TTS processes; up to MAX_WAITING further requests wait for a slot (a reel's lines
  // arrive together), anything beyond that is refused rather than queued without limit.
  if (running >= MAX_OFFLINE_TTS) {
    if (waiting.length >= MAX_WAITING) throw new OfflineTtsBusyError('offline TTS busy');
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  const sampleRate = opts.sampleRate ?? 24000;
  const fl = VOICES[voice] || 'slt';
  // The text goes through a file, never through the filter string, so it cannot inject filter options.
  const file = path.join(os.tmpdir(), `forge-tts-${crypto.randomBytes(8).toString('hex')}.txt`);
  try {
    fs.writeFileSync(file, text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, 1000));
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(opts.ffmpeg || 'ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `flite=textfile='${file}':voice=${fl}`,
        // Slightly brighter and normalised so it sits like a voiceover, not a phone line.
        '-af', 'highpass=f=70,loudnorm=I=-16:TP=-1.5', '-ar', String(sampleRate), '-ac', '1', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let err = '';
      const t = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 20_000);
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
      p.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      p.on('close', (code) => {
        clearTimeout(t);
        const buf = Buffer.concat(out);
        if (code === 0 && buf.length > sampleRate / 10) resolve(buf);
        else reject(new Error(`offline TTS failed: ${err.trim().split('\n').pop() || `exit ${code}`}`));
      });
    });
    return { pcm, sampleRate, voice: fl };
  } finally {
    running--;
    waiting.shift()?.();
    fs.rmSync(file, { force: true });
  }
}
