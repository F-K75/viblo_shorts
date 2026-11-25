// Integration tests for the optional YouTube footage download (server/routes/youtubeDownload.ts), using a stand-in
// yt-dlp (tests/fixtures/fake-yt-dlp.sh) that records its arguments and produces a real MP4.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTestServer, guestToken, type TestServer } from './helpers/server.ts';

const FAKE = path.resolve(import.meta.dirname, 'fixtures/fake-yt-dlp.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-test-'));
const argsFile = path.join(tmp, 'args.txt');

const call = (srv: TestServer, p: string, token: string, body?: unknown) =>
  fetch(srv.baseUrl + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('youtube download: disabled by default', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => srv?.stop());

  test('config says off and the endpoint refuses', async () => {
    const cfg = await (await fetch(`${srv.baseUrl}/api/config`)).json();
    assert.equal(cfg.features.youtubeDownload, false);
    const r = await call(srv, '/api/youtube/download', await guestToken(srv.baseUrl), {
      url: 'https://youtu.be/arj7oStGLkU', startSeconds: 30, endSeconds: 58, rightsConfirmed: true,
    });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'youtube_download_disabled');
  });
});

describe('youtube download: enabled with yt-dlp', () => {
  let srv: TestServer;
  let A: string;
  let M: string;
  before(async () => {
    srv = await startTestServer({ YOUTUBE_DOWNLOAD_ENABLED: 'true', YTDLP_PATH: FAKE, FAKE_YTDLP_ARGS: argsFile });
    A = await guestToken(srv.baseUrl);
    M = await guestToken(srv.baseUrl);
  });
  after(async () => {
    await srv?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('validates rights, link and range before running anything', async () => {
    const base = { url: 'https://youtu.be/arj7oStGLkU', startSeconds: 30, endSeconds: 58 };
    const codes = async (body: unknown) => (await (await call(srv, '/api/youtube/download', A, body)).json()).code;
    assert.equal(await codes(base), 'rights_required');
    assert.equal(await codes({ ...base, rightsConfirmed: 'yes' }), 'rights_required');
    assert.equal(await codes({ ...base, rightsConfirmed: true, url: 'https://evil.example/video.mp4' }), 'not_youtube_url');
    assert.equal(await codes({ ...base, rightsConfirmed: true, endSeconds: 20 }), 'invalid_range');
    assert.equal(await codes({ ...base, rightsConfirmed: true, endSeconds: 30 + 301 }), 'range_too_long');
    assert.ok(!fs.existsSync(argsFile), 'yt-dlp must not run for invalid requests');
  });

  test('downloads only the padded clip section, canonical URL, owner-only file', async () => {
    const r = await call(srv, '/api/youtube/download', A, {
      url: 'https://www.youtube.com/watch?v=arj7oStGLkU&list=PL123&t=10', startSeconds: 30, endSeconds: 58.5, rightsConfirmed: true,
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.match(d.downloadId, /^ytdl_[a-f0-9]{32}$/);
    assert.equal(d.offsetSeconds, 15);
    assert.equal(d.endSeconds, 73.5);

    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(args[args.length - 1], 'https://www.youtube.com/watch?v=arj7oStGLkU', 'only the canonical watch URL');
    assert.equal(args[args.length - 2], '--', 'URL is separated from options');
    assert.ok(args.includes('--no-playlist') && args.includes('--force-keyframes-at-cuts') && args.includes('--no-config'));
    assert.equal(args[args.indexOf('--download-sections') + 1], '*15-73.5');

    const file = await call(srv, `/api/youtube/download/${d.downloadId}`, A);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    const out = path.join(tmp, 'got.mp4');
    fs.writeFileSync(out, Buffer.from(await file.arrayBuffer()));
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    assert.ok(Math.abs(dur - 58.5) < 1, `section length ${dur}`);

    const ranged = await fetch(`${srv.baseUrl}/api/youtube/download/${d.downloadId}`, { headers: { authorization: `Bearer ${A}`, range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);

    assert.equal((await call(srv, `/api/youtube/download/${d.downloadId}`, M)).status, 404, 'other users cannot read it');
    assert.equal((await call(srv, '/api/youtube/download/..%2F..%2Fetc', A)).status, 400);
  });

  test('a failed download reports the reason without local paths and leaves no files', async () => {
    const s2 = await startTestServer({ YOUTUBE_DOWNLOAD_ENABLED: 'true', YTDLP_PATH: FAKE, FAKE_YTDLP_FAIL: '1' });
    try {
      const r = await call(s2, '/api/youtube/download', await guestToken(s2.baseUrl), {
        url: 'https://youtu.be/arj7oStGLkU', startSeconds: 30, endSeconds: 58, rightsConfirmed: true,
      });
      assert.equal(r.status, 502);
      const d = await r.json();
      assert.equal(d.code, 'download_failed');
      assert.match(d.error, /Sign in to confirm you're not a bot/);
      assert.doesNotMatch(d.error, /\/home\/someone/);
      const dir = path.join(s2.dataDir, 'downloads');
      assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
    } finally {
      await s2.stop();
    }
  });

  test('missing yt-dlp binary is reported clearly', async () => {
    const s3 = await startTestServer({ YOUTUBE_DOWNLOAD_ENABLED: 'true', YTDLP_PATH: path.join(tmp, 'no-such-yt-dlp') });
    try {
      const r = await call(s3, '/api/youtube/download', await guestToken(s3.baseUrl), {
        url: 'https://youtu.be/arj7oStGLkU', startSeconds: 30, endSeconds: 58, rightsConfirmed: true,
      });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, 'ytdlp_missing');
    } finally {
      await s3.stop();
    }
  });
});
