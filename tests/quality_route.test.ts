// Integration tests for the post-export quality pipeline (server/routes/quality.ts): upload → conform → evaluate → download.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTestServer, guestToken, type TestServer } from './helpers/server.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
const f = (n: string) => path.join(tmp, n);
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);
let srv: TestServer;
let A: string;
let M: string;

const timeline = {
  durationS: 6,
  scriptText: 'Why does your list fail? Pick one task. Do it first.',
  beats: [
    { text: 'Why does your list fail?', start_s: 0, end_s: 2, asset: 'a', kind: 'broll', visual_keywords: 'list' },
    { text: 'Pick one task.', start_s: 2, end_s: 4, asset: 'b', kind: 'broll', visual_keywords: 'task' },
    { text: 'Do it first.', start_s: 4, end_s: 6, asset: 'c', kind: 'broll', visual_keywords: 'task first' },
  ],
  captions: { enabled: true, chunks: [
    { text: 'Why does your list fail?', start_s: 0.1, end_s: 1.9, words: 5, lines: 2 },
    { text: 'Pick one task.', start_s: 2.1, end_s: 3.9, words: 3, lines: 1 },
    { text: 'Do it first.', start_s: 4.1, end_s: 5.9, words: 3, lines: 1 },
  ] },
  audio: { required: true, narration: false, sourceSpeech: false, music: true, musicVolume: 0.3 },
  target: { width: 1080, height: 1920, fps: 30 },
};

const upload = (token: string, file: string, type = 'video/webm') =>
  fetch(`${srv.baseUrl}/api/quality/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: fs.readFileSync(file) });
const evaluate = (token: string, uploadId: string) =>
  fetch(`${srv.baseUrl}/api/quality/evaluate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId, timeline }) });

before(async () => {
  // Like a browser MediaRecorder file: WebM, VP9 + Opus, quiet.
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'smptebars=s=1080x1920:r=30:d=2', '-f', 'lavfi', '-i', 'rgbtestsrc=s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:d=6,volume=0.05', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]', '-map', '[v]', '-map', '3:a',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-c:a', 'libopus', f('recorded.webm'));
  // Encoder-downscaled recording (the reference reel's defect).
  ff('-i', f('recorded.webm'), '-vf', 'scale=512:910', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', f('small.mp4'));
  srv = await startTestServer({ QUALITY_MAX_UPLOAD_MB: '5' });
  A = await guestToken(srv.baseUrl);
  M = await guestToken(srv.baseUrl);
});
after(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('quality pipeline', () => {
  test('a browser-style WebM is conformed to the delivery spec and the fix is reported', async () => {
    const u = await (await upload(A, f('recorded.webm'))).json();
    assert.match(u.uploadId, /^qa_[a-f0-9]{32}$/);
    const r = await evaluate(A, u.uploadId);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.before.spec.actual.videoCodec, 'vp9');
    assert.ok(d.before.problems.some((p: any) => p.id === 'video_codec'));
    assert.equal(d.evaluation.spec.actual.videoCodec, 'h264');
    assert.equal(d.evaluation.spec.actual.pixFmt, 'yuv420p');
    assert.equal(d.evaluation.spec.actual.audioCodec, 'aac');
    assert.equal(d.evaluation.spec.actual.faststart, true);
    assert.equal(d.evaluation.spec.label, '1080x1920');
    assert.ok(d.remediation.some((x: any) => x.action === 'conform' && x.ok && /video_codec/.test(x.detail)));
    assert.match(d.fileName, /^forge_short_1080x1920_\d+\.mp4$/);
    assert.ok(['PASS', 'NEEDS_IMPROVEMENT', 'REJECTED'].includes(d.evaluation.status));
    for (const dim of d.evaluation.dimensions) assert.ok(typeof dim.score === 'number' && Array.isArray(dim.checks));

    const dl = await fetch(`${srv.baseUrl}/api/quality/download/${u.uploadId}`, { headers: { authorization: `Bearer ${A}` } });
    assert.equal(dl.status, 200);
    const out = f('delivered.mp4');
    fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-of', 'csv=p=0', out]).toString();
    assert.match(probe, /h264,1080,1920,yuv420p/);
    assert.match(probe, /aac/);
    assert.equal((await fetch(`${srv.baseUrl}/api/quality/download/${u.uploadId}`, { headers: { authorization: `Bearer ${M}` } })).status, 404, 'owner only');
  });

  test('a 512x910 recording is NOT upscaled and is rejected with its real size in the name', async () => {
    const u = await (await upload(A, f('small.mp4'), 'video/mp4')).json();
    const d = await (await evaluate(A, u.uploadId)).json();
    assert.equal(d.evaluation.status, 'REJECTED');
    assert.deepEqual([d.evaluation.spec.actual.width, d.evaluation.spec.actual.height], [512, 910]);
    assert.ok(d.evaluation.criticalDefects.some((c: any) => c.id === 'dimensions'));
    assert.match(d.fileName, /^forge_short_512x910_/);
    assert.ok(/No upscaling/.test(d.remediation[0].detail));
  });

  test('validation: other users, wrong type, too large, unreadable file', async () => {
    const u = await (await upload(A, f('small.mp4'), 'video/mp4')).json();
    assert.equal((await evaluate(M, u.uploadId)).status, 404);
    assert.equal((await upload(A, f('small.mp4'), 'text/plain')).status, 415);
    const big = f('big.bin');
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024));
    assert.equal((await upload(A, big, 'application/octet-stream')).status, 413);
    const junk = f('junk.mp4');
    fs.writeFileSync(junk, Buffer.from('not a video at all'));
    const j = await (await upload(A, junk, 'video/mp4')).json();
    const d = await (await evaluate(A, j.uploadId)).json();
    assert.equal(d.evaluation.status, 'REJECTED');
    assert.ok(d.evaluation.criticalDefects.length >= 1);
  });
});
