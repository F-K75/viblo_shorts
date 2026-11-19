import type express from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Optional YouTube footage download (OFF by default).
 *
 * The browser cannot record YouTube's embedded player, so a clip made from a link alone has no footage or voice.
 * When the operator sets YOUTUBE_DOWNLOAD_ENABLED=true and yt-dlp is installed, signed-in users (and guests) can
 * fetch just the clip section of a video they own or have permission to use. Safety:
 *  - only a validated 11-character video id reaches yt-dlp (canonical watch URL, no arbitrary URLs → no SSRF);
 *  - argument array, no shell; size cap, wall-clock timeout, concurrency cap, section length cap;
 *  - files are owner-only (sidecar metadata survives restarts) and deleted after a TTL.
 * Downloading videos you have no rights to violates YouTube's Terms of Service; the user must confirm rights.
 */
export interface YouTubeDownloadDeps {
  dataDir: string;
  rateLimit: (group: string, maxPerMinute: number, opts?: { ai?: boolean }) => express.RequestHandler;
  uid: (req: express.Request) => string;
  extractYouTubeId: (input: string) => string | null;
  parseRangeHeader: (header: string | undefined, size: number) => { start: number; end: number } | 'unsatisfiable' | null;
  env?: NodeJS.ProcessEnv;
}

const ID_RE = /^ytdl_[a-f0-9]{32}$/;

export function youTubeDownloadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YOUTUBE_DOWNLOAD_ENABLED === 'true';
}

export function registerYouTubeDownloadRoutes(app: express.Express, deps: YouTubeDownloadDeps): { stop: () => void } {
  const env = deps.env || process.env;
  const num = (name: string, def: number, min: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= min ? v : def;
  };
  const enabled = youTubeDownloadEnabled(env);
  const bin = env.YTDLP_PATH || 'yt-dlp';
  const maxMb = num('YTDLP_MAX_MB', 500, 1);
  const timeoutS = num('YTDLP_TIMEOUT_S', 300, 5);
  const maxConcurrent = Math.floor(num('YTDLP_MAX_CONCURRENT', 2, 1));
  const ttlMs = num('YTDLP_TTL_MIN', 60, 1) * 60_000;
  const padS = num('YTDLP_PAD_S', 15, 0);
  const maxSectionS = num('YTDLP_MAX_SECTION_S', 300, 10);
  const dir = path.join(deps.dataDir, 'downloads');
  const running = new Set<ChildProcess>();

  const metaPath = (id: string) => path.join(dir, `${id}.json`);
  const videoPath = (id: string) => path.join(dir, `${id}.mp4`);

  const sweep = () => {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > ttlMs) fs.rmSync(p, { force: true });
      } catch {
        // raced with another sweep or a download
      }
    }
  };
  const timer = enabled ? setInterval(sweep, Math.min(ttlMs, 10 * 60_000)) : null;
  timer?.unref();

  app.post('/api/youtube/download', deps.rateLimit('youtube-download', 6), async (req, res) => {
    if (!enabled) {
      return res.status(404).json({
        code: 'youtube_download_disabled',
        error: 'Downloading from YouTube is turned off on this server. Add your own video file instead.',
      });
    }
    if (req.body?.rightsConfirmed !== true) {
      return res.status(400).json({ code: 'rights_required', error: 'Confirm that you own this video or have permission to use it.' });
    }
    const videoId = deps.extractYouTubeId(typeof req.body?.url === 'string' ? req.body.url.slice(0, 300) : '');
    if (!videoId) return res.status(400).json({ code: 'not_youtube_url', error: 'A valid YouTube video link is required.' });
    const start = Number(req.body?.startSeconds);
    const end = Number(req.body?.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 24 * 3600) {
      return res.status(400).json({ code: 'invalid_range', error: 'startSeconds and endSeconds must describe the clip range.' });
    }
    if (end - start > maxSectionS) {
      return res.status(400).json({ code: 'range_too_long', error: `Clips can be at most ${maxSectionS} seconds.` });
    }
    if (running.size >= maxConcurrent) {
      return res.status(429).json({ code: 'busy', error: 'Another download is in progress. Try again in a minute.' });
    }

    fs.mkdirSync(dir, { recursive: true });
    sweep();
    const id = `ytdl_${crypto.randomBytes(16).toString('hex')}`;
    const from = Math.max(0, Math.floor((start - padS) * 100) / 100);
    const to = Math.ceil((end + padS) * 100) / 100;
    const args = [
      '--no-playlist', '--no-progress', '--no-warnings', '--no-cache-dir', '--no-config',
      '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--download-sections', `*${from}-${to}`,
      // Cut exactly at the requested times so `from` is the true start of the file (captions stay in sync).
      '--force-keyframes-at-cuts',
      '--max-filesize', `${maxMb}M`,
      '-o', path.join(dir, `${id}.%(ext)s`),
      '--', `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const result = await new Promise<{ ok: boolean; missing?: boolean; detail?: string; timedOut?: boolean }>((resolve) => {
      let stderr = '';
      let proc: ChildProcess;
      try {
        proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        return resolve({ ok: false, missing: true });
      }
      running.add(proc);
      const killer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({ ok: false, timedOut: true });
      }, timeoutS * 1000);
      proc.stderr?.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(killer);
        running.delete(proc);
        resolve({ ok: false, missing: e.code === 'ENOENT' });
      });
      proc.on('close', (code) => {
        clearTimeout(killer);
        running.delete(proc);
        resolve({ ok: code === 0, detail: stderr });
      });
    });

    if (!result.ok || !fs.existsSync(videoPath(id))) {
      for (const f of fs.readdirSync(dir)) if (f.startsWith(id)) fs.rmSync(path.join(dir, f), { force: true });
      if (result.missing) {
        return res.status(503).json({ code: 'ytdlp_missing', error: 'yt-dlp is not installed on the server (or YTDLP_PATH is wrong).' });
      }
      if (result.timedOut) return res.status(504).json({ code: 'timeout', error: 'The download took too long. Try a shorter clip.' });
      // Last ERROR line only, without local paths.
      const line = (result.detail || '').split('\n').reverse().find((l) => /ERROR/.test(l)) || '';
      const reason = line.replace(/\/[^\s'"]+/g, '').replace(/^.*?ERROR:\s*/, '').slice(0, 200);
      console.warn('[youtube-download] failed:', reason || 'unknown');
      return res.status(502).json({ code: 'download_failed', error: `YouTube download failed${reason ? `: ${reason}` : ''}.` });
    }

    const sizeBytes = fs.statSync(videoPath(id)).size;
    fs.writeFileSync(metaPath(id), JSON.stringify({ userId: deps.uid(req), videoId, from, to, createdAt: new Date().toISOString() }));
    res.json({ downloadId: id, videoId, offsetSeconds: from, endSeconds: to, sizeBytes });
  });

  app.get('/api/youtube/download/:downloadId', deps.rateLimit('youtube-download-file', 60), (req, res) => {
    const { downloadId } = req.params;
    if (!ID_RE.test(downloadId)) return res.status(400).json({ error: 'Invalid download id' });
    let meta: { userId?: string } = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(downloadId), 'utf8'));
    } catch {
      return res.status(404).json({ error: 'Download not found or expired.' });
    }
    if (meta.userId !== deps.uid(req) || !fs.existsSync(videoPath(downloadId))) {
      return res.status(404).json({ error: 'Download not found or expired.' });
    }
    const file = videoPath(downloadId);
    const size = fs.statSync(file).size;
    const range = deps.parseRangeHeader(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    if (range) {
      res.writeHead(206, {
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': range.end - range.start + 1,
        'Content-Type': 'video/mp4',
      });
      return void fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      for (const p of running) p.kill('SIGKILL');
    },
  };
}
