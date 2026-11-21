import type express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateStoryWithAi } from '../lib/videoQuality/aiEvaluator.ts';
import { evaluate, evaluatePreflight, loadThresholds } from '../lib/videoQuality/evaluator.ts';
import type { Evaluation, MediaFacts, Timeline, TimelineBeat } from '../lib/videoQuality/models.ts';
import { detectFfmpegCapabilities, probeMedia } from '../lib/videoQuality/probe.ts';

/**
 * Post-export quality pipeline:
 *   upload (exported reel) -> probe -> conform to delivery spec -> evaluate (deterministic + optional AI) -> gate -> download.
 *
 * Conform re-encodes to H.264 High / yuv420p / constant target fps / AAC 48 kHz stereo / -14 LUFS (only when audible) / +faststart.
 * It NEVER upscales: a recording smaller than target keeps its real dimensions so the export check catches and rejects it honestly.
 */
export interface QualityDeps {
  dataDir: string;
  rateLimit: (group: string, maxPerMinute: number, opts?: { ai?: boolean }) => express.RequestHandler;
  uid: (req: express.Request) => string;
  maxUploadBytes: number;
  env?: NodeJS.ProcessEnv;
  resolveGeminiApiKey?: () => string | null;
}

const ID_RE = /^qa_[a-f0-9]{32}$/;
const num = (v: unknown, lo: number, hi: number, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const ROLES = new Set(['hook', 'context', 'main', 'progression', 'cta']);
const KINDS = new Set(['source', 'broll', 'image', 'motion']);

/** Validates the client-supplied timeline (shape, sizes, finite numbers). */
export function sanitizeTimeline(input: any): Timeline | null {
  if (!input || typeof input !== 'object') return null;
  const beats: TimelineBeat[] = (Array.isArray(input.beats) ? input.beats : []).slice(0, 200).map((b: any) => ({
    text: str(b?.text, 600),
    start_s: num(b?.start_s, 0, 3600),
    end_s: num(b?.end_s, 0, 3600),
    visual_keywords: str(b?.visual_keywords, 200) || undefined,
    asset: str(b?.asset, 300) || undefined,
    role: ROLES.has(b?.role) ? b.role : undefined,
    kind: KINDS.has(b?.kind) ? b.kind : undefined,
  }));
  const chunks: Timeline['captions']['chunks'] = (Array.isArray(input.captions?.chunks) ? input.captions.chunks : [])
    .slice(0, 3000)
    .map((c: any) => ({
      text: str(c?.text, 300),
      start_s: num(c?.start_s, -10, 3600),
      end_s: num(c?.end_s, -10, 3600),
      words: Math.round(num(c?.words, 0, 100)),
      lines: c?.lines === undefined ? undefined : Math.round(num(c?.lines, 0, 20)),
      wordTimings: Array.isArray(c?.wordTimings)
        ? c.wordTimings.slice(0, 50).map((w: any) => ({
            word: str(w?.word, 80),
            start_s: num(w?.start_s, -10, 3600),
            end_s: num(w?.end_s, -10, 3600),
          }))
        : undefined,
    }));
  const t = input.target;
  const grouping = input.captions?.grouping === 'words' ? 'words' : input.captions?.grouping === 'phrase' ? 'phrase' : undefined;
  return {
    durationS: num(input.durationS, 0, 3600),
    scriptText: str(input.scriptText, 50_000),
    beats,
    captions: {
      enabled: input.captions?.enabled !== false,
      chunks,
      maxLines: input.captions?.maxLines ? Math.round(num(input.captions.maxLines, 1, 6)) : undefined,
      positionY: input.captions?.positionY === undefined ? undefined : num(input.captions.positionY, 0, 100),
      fontSize: input.captions?.fontSize === undefined ? undefined : num(input.captions.fontSize, 8, 200),
      grouping,
    },
    audio: {
      required: input.audio?.required !== false,
      narration: Boolean(input.audio?.narration),
      sourceSpeech: Boolean(input.audio?.sourceSpeech),
      music: Boolean(input.audio?.music),
      musicVolume: input.audio?.musicVolume === undefined ? undefined : num(input.audio.musicVolume, 0, 1),
      clientMeasuredPeakDb:
        input.audio?.clientMeasuredPeakDb === undefined || input.audio?.clientMeasuredPeakDb === null
          ? undefined
          : num(input.audio.clientMeasuredPeakDb, -120, 6),
      clientMeasuredRmsDb:
        input.audio?.clientMeasuredRmsDb === undefined || input.audio?.clientMeasuredRmsDb === null
          ? undefined
          : num(input.audio.clientMeasuredRmsDb, -120, 6),
    },
    target: t ? { width: Math.round(num(t.width, 64, 4096, 1080)), height: Math.round(num(t.height, 64, 4096, 1920)), fps: num(t.fps, 1, 120, 30) } : undefined,
  };
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    p.on('error', () => {
      clearTimeout(t);
      resolve({ ok: false, stderr: 'ffmpeg not available' });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, stderr });
    });
  });
}

/**
 * Builds the delivery conform FFmpeg command.
 * - Scales DOWN to fit target if larger; NEVER upscales.
 * - Uses `-fps_mode cfr` on FFmpeg 5.1+ and `-vsync cfr` on FFmpeg 4.x so conform works reliably across versions.
 * - Applies EBU R128 loudness normalization (-14 LUFS) ONLY when the audio signal is actually audible; silent audio
 *   is never artificially amplified or disguised as speech.
 */
export function conformArgs(
  src: string,
  out: string,
  facts: MediaFacts,
  target: { width: number; height: number; fps: number },
  caps: { hasFpsMode: boolean } = detectFfmpegCapabilities(),
): string[] {
  const v = facts.video!;
  const fits = v.width <= target.width && v.height <= target.height;
  const scale = fits
    ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    : `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  const cfrFlag = caps.hasFpsMode ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    src,
    '-map',
    '0:v:0',
    '-vf',
    `${scale},fps=${target.fps},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    ...cfrFlag,
  ];
  if (facts.audio) {
    const audible =
      (facts.analysis.meanVolumeDb !== null && facts.analysis.meanVolumeDb > -58) ||
      (facts.analysis.maxVolumeDb !== null && facts.analysis.maxVolumeDb > -48);
    args.push('-map', '0:a:0');
    if (audible) {
      args.push('-af', 'loudnorm=I=-14:TP=-1.5:LRA=11');
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  }
  args.push('-movflags', '+faststart', out);
  return args;
}

const summary = (e: Evaluation) => ({
  score: e.score,
  classification: e.classification,
  action: e.action,
  readyToPublish: e.readyToPublish,
  status: e.status,
  spec: e.spec,
  problems: e.problems.map((p) => ({ id: p.id, severity: p.severity, message: p.message })),
});

export function registerQualityRoutes(app: express.Express, deps: QualityDeps): { stop: () => void } {
  const env = deps.env || process.env;
  const dir = path.join(deps.dataDir, 'quality');
  const ttlMs = num(env.QUALITY_TTL_MIN, 1, 1440, 30) * 60_000;
  const maxConcurrent = Math.floor(num(env.QUALITY_MAX_CONCURRENT, 1, 16, 2));
  const timeoutMs = num(env.QUALITY_TIMEOUT_S, 10, 3600, 300) * 1000;
  let running = 0;
  const p = (id: string, ext: string) => path.join(dir, `${id}.${ext}`);
  const ownerOk = (req: express.Request, id: string) => {
    try {
      return JSON.parse(fs.readFileSync(p(id, 'json'), 'utf8')).userId === deps.uid(req);
    } catch {
      return false;
    }
  };
  const sweep = () => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > ttlMs) fs.rmSync(fp, { force: true });
      } catch {
        // raced with another sweep
      }
    }
  };
  const timer = setInterval(sweep, Math.min(ttlMs, 10 * 60_000));
  timer.unref();

  // 0. Preflight / post-edit timeline quality evaluation (instant, no video upload required).
  app.post('/api/quality/preflight', deps.rateLimit('quality-preflight', 60), async (req, res) => {
    const timeline = sanitizeTimeline(req.body?.timeline);
    if (!timeline) return res.status(400).json({ error: 'Timeline payload is required.' });
    const th = loadThresholds(env);
    const apiKey = deps.resolveGeminiApiKey ? deps.resolveGeminiApiKey() : env.GEMINI_API_KEY || null;
    const aiReview = req.body?.useAi === false ? undefined : await evaluateStoryWithAi(timeline, { apiKey: apiKey ?? undefined, model: env.QUALITY_AI_MODEL, timeoutMs: 8_000 });
    const evaluation = evaluatePreflight(timeline, th, aiReview);
    return res.json({ mode: 'preflight', evaluation });
  });

  // 1. Upload the exported reel (streamed to disk, size-capped). Source footage is never uploaded.
  app.post('/api/quality/uploads', deps.rateLimit('quality-upload', 20), (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^(video\/(mp4|webm|quicktime)|application\/octet-stream)\b/.test(type)) {
      return res.status(415).json({ code: 'unsupported_type', error: 'Upload the exported video (video/mp4 or video/webm).' });
    }
    fs.mkdirSync(dir, { recursive: true });
    sweep();
    const id = `qa_${crypto.randomBytes(16).toString('hex')}`;
    const file = p(id, 'src');
    const out = fs.createWriteStream(file);
    let bytes = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > deps.maxUploadBytes && !aborted) {
        aborted = true;
        out.destroy();
        fs.rmSync(file, { force: true });
        res.status(413).json({ code: 'payload_too_large', error: `Video too large (max ${Math.round(deps.maxUploadBytes / 1048576)} MB).` });
        req.resume();
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      if (bytes === 0) {
        fs.rmSync(file, { force: true });
        return res.status(400).json({ code: 'empty', error: 'The uploaded video is empty.' });
      }
      fs.writeFileSync(p(id, 'json'), JSON.stringify({ userId: deps.uid(req), bytes, type, createdAt: new Date().toISOString() }));
      res.json({ uploadId: id, bytes });
    });
    out.on('error', () => {
      if (!aborted && !res.headersSent) res.status(500).json({ error: 'Could not store the upload.' });
    });
  });

  // 2. Conform + evaluate (before and after), gate, and prepare the delivery file.
  app.post('/api/quality/evaluate', deps.rateLimit('quality-evaluate', 20), async (req, res) => {
    const id = String(req.body?.uploadId || '');
    if (!ID_RE.test(id) || !ownerOk(req, id) || !fs.existsSync(p(id, 'src'))) return res.status(404).json({ error: 'Upload not found or expired.' });
    if (running >= maxConcurrent) return res.status(429).json({ code: 'busy', error: 'Quality checks are busy. Try again in a minute.' });
    const timeline = sanitizeTimeline(req.body?.timeline);
    const th = loadThresholds(env);
    const target = timeline?.target || { width: th.spec.width, height: th.spec.height, fps: th.spec.fps };
    const apiKey = deps.resolveGeminiApiKey ? deps.resolveGeminiApiKey() : env.GEMINI_API_KEY || null;
    running++;
    try {
      const aiReviewPromise =
        timeline && req.body?.useAi !== false
          ? evaluateStoryWithAi(timeline, { apiKey: apiKey ?? undefined, model: env.QUALITY_AI_MODEL, timeoutMs: 10_000 })
          : Promise.resolve(undefined);

      let rawFacts: MediaFacts | null = null;
      try {
        rawFacts = await probeMedia(p(id, 'src'), { timeoutMs });
      } catch (e) {
        const aiReview = await aiReviewPromise;
        const ev = evaluate(null, timeline, th, aiReview);
        return res.json({
          evaluation: ev,
          before: summary(ev),
          remediation: [{ action: 'probe', ok: false, detail: (e as Error).message }],
          downloadId: null,
        });
      }

      const aiReview = await aiReviewPromise;
      const before = evaluate(rawFacts, timeline, th, aiReview);
      const remediation: Array<{ action: string; ok: boolean; detail: string }> = [];
      let final = before;
      let deliver: string | null = null;

      if (rawFacts.video && req.body?.conform !== false) {
        const conformed = p(id, 'mp4');
        const r = await runFfmpeg(conformArgs(p(id, 'src'), conformed, rawFacts, target), timeoutMs);
        if (r.ok && fs.existsSync(conformed)) {
          const after = evaluate(await probeMedia(conformed, { timeoutMs }), timeline, th, aiReview);
          const fixed = before.problems
            .filter((b) => b.dimension === 'export' || b.dimension === 'audio' || b.dimension === 'technical')
            .filter((b) => !after.problems.some((a) => a.id === b.id))
            .map((b) => b.id);
          const audible =
            rawFacts.audio &&
            ((rawFacts.analysis.meanVolumeDb !== null && rawFacts.analysis.meanVolumeDb > -58) ||
              (rawFacts.analysis.maxVolumeDb !== null && rawFacts.analysis.maxVolumeDb > -48));
          remediation.push({
            action: 'conform',
            ok: true,
            detail: `Re-encoded to H.264/yuv420p/${target.fps} fps CFR/AAC${audible ? '/-14 LUFS' : ''}/faststart${fixed.length ? `; fixed: ${fixed.join(', ')}` : ''}. No upscaling.`,
          });
          final = after;
          deliver = conformed;
        } else {
          remediation.push({ action: 'conform', ok: false, detail: r.stderr.split('\n').filter(Boolean).pop()?.slice(0, 200) || 'ffmpeg failed' });
        }
      }

      if (!deliver) deliver = p(id, 'src');
      fs.writeFileSync(p(id, 'deliver'), JSON.stringify({ file: path.basename(deliver), label: final.spec.label }));
      res.json({
        evaluation: final,
        before: summary(before),
        remediation,
        downloadId: id,
        fileName: `forge_short_${final.spec.label}_${Date.now()}.mp4`,
      });
    } catch (e) {
      res.status(500).json({ error: 'Quality evaluation failed.', detail: (e as Error).message.slice(0, 200) });
    } finally {
      running--;
    }
  });

  // 3. Download the delivery file (owner only).
  app.get('/api/quality/download/:id', deps.rateLimit('quality-download', 60), (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id) || !ownerOk(req, id)) return res.status(404).json({ error: 'Not found or expired.' });
    let file: string;
    try {
      file = path.join(dir, path.basename(JSON.parse(fs.readFileSync(p(id, 'deliver'), 'utf8')).file));
    } catch {
      return res.status(404).json({ error: 'Not evaluated yet.' });
    }
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found or expired.' });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });

  return { stop: () => clearInterval(timer) };
}
