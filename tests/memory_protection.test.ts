// Track C (R-13): request bodies, memory and slow clients. Every test runs against a real server process and
// therefore on both backends (TEST_STORAGE_BACKEND=json|postgres).
//   * route-specific body limits, enforced from Content-Length and while streaming (chunked bodies)
//   * unauthenticated requests are rejected before their body is read
//   * a bounded number of large bodies in flight per instance (backpressure: 503 busy + Retry-After)
//   * a memory guard: body-heavy and render requests get 503 and readiness drains the instance, then recovers
//   * slow clients (headers or body trickled) are disconnected
//   * memory stays bounded under concurrent oversized and slow requests
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, guestToken, healthDetails, type TestServer } from './helpers/server.ts';

const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
async function boot(env: Record<string, string> = {}) {
  const s = await startTestServer({ BACKUP_INTERVAL_HOURS: '0', ...env });
  cleanups.push(() => s.stop());
  return s;
}

interface Sent {
  /** ms from the first byte sent until the response headers arrived */
  ms: number;
  status: number | null;
  body: any;
  headers: http.IncomingHttpHeaders;
  error?: string;
}
/**
 * Sends a request body with full control: fixed Content-Length or chunked, all at once or trickled.
 * Resolves with the response even when the server answers before the body is finished (early 413/503).
 */
function send(
  s: TestServer,
  opts: { method?: string; path: string; token?: string; body: Buffer; chunked?: boolean; trickleMs?: number; pieces?: number },
): Promise<Sent> {
  const u = new URL(s.baseUrl);
  return new Promise((resolve) => {
    let settled = false;
    const t0 = Date.now();
    let headersAt = 0;
    const done = (r: Omit<Sent, 'ms'>) => {
      if (!settled) {
        settled = true;
        resolve({ ...r, ms: (headersAt || Date.now()) - t0 });
      }
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (!opts.chunked) headers['content-length'] = String(opts.body.length);
    const req = http.request({ host: u.hostname, port: u.port, method: opts.method || 'POST', path: opts.path, headers, agent: false }, (res) => {
      headersAt = Date.now();
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let body: any = data;
        try {
          body = JSON.parse(data);
        } catch {
          // not JSON
        }
        done({ status: res.statusCode ?? null, body, headers: res.headers });
      });
      res.on('error', () => done({ status: res.statusCode ?? null, body: null, headers: res.headers }));
    });
    req.on('error', (e) => setTimeout(() => done({ status: null, body: null, headers: {}, error: e.message }), 50));
    const pieces = opts.pieces ?? (opts.trickleMs ? 10 : 1);
    const size = Math.ceil(opts.body.length / pieces);
    let i = 0;
    const next = () => {
      if (settled || req.destroyed) return;
      if (i >= pieces) return void req.end();
      const ok = req.write(opts.body.subarray(i * size, (i + 1) * size));
      i++;
      if (opts.trickleMs) setTimeout(next, opts.trickleMs);
      else if (ok) next();
      else req.once('drain', next);
    };
    next();
  });
}
const json = (o: unknown) => Buffer.from(JSON.stringify(o));
/** A JSON body of roughly `bytes` size whose payload field is `field`. */
const sized = (bytes: number, field = 'text', extra: Record<string, unknown> = {}) => json({ ...extra, [field]: 'x'.repeat(bytes) });

describe('C2: route-specific body limits', () => {
  test('a small-payload route rejects a 100 KB body with 413 before parsing; legitimate large payloads still work', async () => {
    const s = await boot();
    const token = s.signFirebaseToken({ sub: 'c2-user' });
    const tts = await send(s, { path: '/api/tts', token, body: sized(100_000) });
    assert.equal(tts.status, 413, JSON.stringify(tts.body));
    assert.equal(tts.body?.code, 'payload_too_large');
    // routes that legitimately carry a whole project keep the project limit (512 KB + margin)
    const project = await send(s, { path: '/api/projects', token, body: json({ title: 'big but legal', notes: 'y'.repeat(480_000) }) });
    assert.equal(project.status, 200, JSON.stringify(project.body).slice(0, 300));
    const meta = await send(s, { path: '/api/gemini/optimize-metadata', token, body: json({ topic: 't', beats: Array.from({ length: 30 }, (_, i) => ({ text: 'z'.repeat(6_000), i })) }) });
    assert.notEqual(meta.status, 413, 'optimize-metadata sends the whole script and must not be cut off');
    // pasted transcripts keep their 1 MB limit (the server truncates them after parsing)
    const transcript = await send(s, { path: '/api/youtube/parse-transcript', token, body: json({ transcript: 'w '.repeat(400_000) }) });
    assert.notEqual(transcript.status, 413);
    // over the project limit: rejected by the transport limit, not by the handler
    const huge = await send(s, { path: '/api/projects', token, body: json({ title: 'too big', notes: 'q'.repeat(700_000) }) });
    assert.equal(huge.status, 413);
    assert.equal(huge.body?.code, 'payload_too_large');
  });

  test('a chunked body (no Content-Length) is cut off at the route limit while streaming', async () => {
    const s = await boot();
    const token = await guestToken(s.baseUrl);
    const r = await send(s, { path: '/api/tts', token, body: sized(200_000), chunked: true, pieces: 20 });
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body?.code, 'payload_too_large');
  });

  test('an unauthenticated request is rejected with 401 before its body is read', async () => {
    const s = await boot();
    // two anonymous 400 KB uploads, each trickled over ~2 s: answered long before the upload could have finished
    const [a, b] = await Promise.all([
      send(s, { path: '/api/projects', body: sized(400_000, 'notes', { title: 'anon' }), trickleMs: 100, pieces: 20 }),
      send(s, { path: '/api/projects', body: sized(400_000, 'notes', { title: 'anon' }), trickleMs: 100, pieces: 20 }),
    ]);
    assert.deepEqual([a.status, b.status], [401, 401]);
    assert.ok(a.ms < 900 && b.ms < 900, `401 sent without waiting for the body (${a.ms} ms, ${b.ms} ms; the upload takes ~2000 ms)`);
  });
});

describe('C3: bounded large bodies in flight (backpressure)', () => {
  test('with BODY_CONCURRENCY=3, 12 concurrent slow 300 KB uploads: at most 3 in flight, the rest get 503 busy + Retry-After', async () => {
    const s = await boot({ BODY_CONCURRENCY: '3' });
    const token = s.signFirebaseToken({ sub: 'c3-bulk-user' }); // signed-in: the guest project cap (10) must not interfere
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => send(s, { path: '/api/projects', token, body: sized(300_000, 'notes', { title: `slow ${i}` }), trickleMs: 150 })),
    );
    const statuses = results.map((r) => r.status);
    const busy = results.filter((r) => r.status === 503);
    assert.ok(busy.length >= 6, `excess uploads refused: ${statuses.join(',')}`);
    assert.ok(busy.every((r) => r.body?.code === 'busy' && Number(r.headers['retry-after']) > 0));
    assert.ok(results.filter((r) => r.status === 200).length >= 3, `admitted uploads succeed: ${statuses.join(',')}`);
    const d = await healthDetails(s.baseUrl);
    assert.ok(d.requests?.largeBodiesInFlightMax !== undefined && d.requests.largeBodiesInFlightMax <= 3, `gauge: ${JSON.stringify(d.requests)}`);
    // capacity comes back: a new upload succeeds once the others finished
    assert.equal((await send(s, { path: '/api/projects', token, body: sized(300_000, 'notes', { title: 'after' }) })).status, 200);
  });
});

describe('C4: memory guard', () => {
  test('above MEMORY_SOFT_LIMIT_MB: body-heavy and render requests get 503, readiness drains; below 90 % it recovers', async () => {
    const rssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c4-')), 'rss');
    fs.writeFileSync(rssFile, '100');
    const s = await boot({ MEMORY_SOFT_LIMIT_MB: '500', MEMORY_SAMPLE_MS: '100', MEMORY_RSS_TEST_FILE: rssFile, READY_CACHE_MS: '0' });
    const token = await guestToken(s.baseUrl);
    const waitReady = async (want: number) => {
      for (let i = 0; i < 50; i++) {
        if ((await fetch(`${s.baseUrl}/api/ready`)).status === want) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`readiness never became ${want}`);
    };
    await waitReady(200);
    fs.writeFileSync(rssFile, '600');
    await waitReady(503);
    const ready = await (await fetch(`${s.baseUrl}/api/ready`)).json();
    assert.equal(ready.checks.memory, false);
    const big = await send(s, { path: '/api/projects', token, body: sized(200_000, 'notes', { title: 'during pressure' }) });
    assert.equal(big.status, 503);
    assert.equal(big.body?.code, 'memory_pressure');
    const render = await send(s, { path: '/api/render/video', token, body: json({ title: 'x', duration: 5, beats: [{ text: 'hi', start_s: 0, end_s: 2 }] }) });
    assert.equal(render.status, 503);
    assert.equal(render.body?.code, 'memory_pressure');
    assert.equal((await fetch(`${s.baseUrl}/api/projects`, { headers: { authorization: `Bearer ${token}` } })).status, 200, 'small requests keep working');
    assert.equal((await fetch(`${s.baseUrl}/api/live`)).status, 200, 'liveness stays up: the instance is drained, not killed');
    fs.writeFileSync(rssFile, '460'); // below the limit but above 90 %: still guarded (hysteresis)
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await fetch(`${s.baseUrl}/api/ready`)).status, 503);
    fs.writeFileSync(rssFile, '300');
    await waitReady(200);
    assert.equal((await send(s, { path: '/api/projects', token, body: sized(200_000, 'notes', { title: 'after pressure' }) })).status, 200);
  });
});

describe('C5: slow clients are disconnected', () => {
  /** Opens a raw connection, sends `first`, then one byte of `rest` every `everyMs`; resolves with ms until the server closed it. */
  function trickle(s: TestServer, first: string, rest: string, everyMs: number, giveUpMs: number): Promise<{ closedAfterMs: number | null; response: string }> {
    const u = new URL(s.baseUrl);
    return new Promise((resolve) => {
      const t0 = Date.now();
      let response = '';
      let i = 0;
      const sock = net.connect(Number(u.port), u.hostname, () => {
        sock.write(first);
        const timer = setInterval(() => {
          if (sock.destroyed || i >= rest.length) return clearInterval(timer);
          sock.write(rest[i++]);
        }, everyMs);
      });
      sock.on('data', (d) => (response += d));
      const finish = (closedAfterMs: number | null) => {
        sock.destroy();
        resolve({ closedAfterMs, response });
      };
      sock.on('close', () => finish(Date.now() - t0));
      sock.on('error', () => {});
      setTimeout(() => finish(null), giveUpMs);
    });
  }

  test('headers trickled one byte per 400 ms are cut off by HEADERS_TIMEOUT_MS', async () => {
    const s = await boot({ HEADERS_TIMEOUT_MS: '1500', REQUEST_TIMEOUT_MS: '3000' });
    const r = await trickle(s, 'POST /api/projects HTTP/1.1\r\nHost: x\r\n', 'X-Slow: ' + 'a'.repeat(200), 400, 12_000);
    assert.ok(r.closedAfterMs !== null && r.closedAfterMs < 6000, `closed after ${r.closedAfterMs} ms`);
  });

  test('a body trickled one byte per 400 ms is cut off by REQUEST_TIMEOUT_MS', async () => {
    const s = await boot({ HEADERS_TIMEOUT_MS: '1500', REQUEST_TIMEOUT_MS: '3000' });
    const token = await guestToken(s.baseUrl);
    const head = `POST /api/tts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: Bearer ${token}\r\nContent-Length: 5000\r\n\r\n`;
    const r = await trickle(s, head, '{"text":"' + 'b'.repeat(4000), 400, 12_000);
    assert.ok(r.closedAfterMs !== null && r.closedAfterMs < 7000, `closed after ${r.closedAfterMs} ms`);
  });
});

describe('C exit criterion: memory stays bounded under concurrent oversized and slow requests', () => {
  test('60 slow 450 KB uploads + 20 oversized 2 MB uploads + 20 slow-header connections at once', async () => {
    const s = await boot({ BODY_CONCURRENCY: '4', HEADERS_TIMEOUT_MS: '2000', REQUEST_TIMEOUT_MS: '8000', USER_MAX_STORAGE_MB: '500' });
    const token = s.signFirebaseToken({ sub: 'c-exit-user' }); // signed-in: guest caps must not interfere
    const rss0 = (await healthDetails(s.baseUrl)).system.rssMb;
    const u = new URL(s.baseUrl);
    const slowHeaders = Array.from({ length: 20 }, () => {
      const sock = net.connect(Number(u.port), u.hostname, () => sock.write('POST /api/projects HTTP/1.1\r\nHost: x\r\n'));
      sock.on('error', () => {});
      return sock;
    });
    const results = await Promise.all([
      ...Array.from({ length: 60 }, (_, i) => send(s, { path: '/api/projects', token, body: sized(450_000, 'notes', { title: `bulk ${i}` }), trickleMs: 80 })),
      ...Array.from({ length: 20 }, () => send(s, { path: '/api/projects', token, body: sized(2_000_000, 'notes', { title: 'oversized' }) })),
    ]);
    for (const sock of slowHeaders) sock.destroy();
    const d = await healthDetails(s.baseUrl);
    const rss1 = d.system.rssMb;
    const statuses = results.map((r) => r.status ?? r.error);
    assert.ok(results.slice(60).every((r) => r.status === 413), `every oversized upload gets its 413 (no broken pipe): ${statuses.slice(60).join(',')}`);
    assert.ok(d.requests.rejectedTooLarge >= 20, 'refused from Content-Length, before any byte was read');
    assert.ok(d.requests?.largeBodiesInFlightMax !== undefined && d.requests.largeBodiesInFlightMax <= 4, `at most 4 large bodies in memory at once: ${JSON.stringify(d.requests)}`);
    assert.ok(results.slice(0, 60).some((r) => r.status === 503), 'excess uploads refused with backpressure');
    assert.equal((await fetch(`${s.baseUrl}/api/live`)).status, 200, 'the server stays healthy');
    console.log(JSON.stringify({ event: 'c_exit_memory', rssBeforeMb: rss0, rssAfterMb: rss1, growthMb: Math.round((rss1 - rss0) * 10) / 10, statuses: statuses.reduce((a: any, k: any) => ((a[k] = (a[k] || 0) + 1), a), {}) }));
    assert.ok(rss1 - rss0 < 120, `RSS growth ${rss1 - rss0} MB stays bounded`);
  });
});

describe('Correction 1: FFmpeg-aware memory budget in the running server', () => {
  test('1 GB container, 2 renders: Node threshold 307 MB (not 819); guard and readiness act at that threshold', async () => {
    const rssFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c6-')), 'rss');
    fs.writeFileSync(rssFile, '200');
    const s = await boot({ MEMORY_CONTAINER_LIMIT_MB: '1024', MAX_CONCURRENT_RENDERS: '2', MEMORY_SAMPLE_MS: '100', MEMORY_RSS_TEST_FILE: rssFile, READY_CACHE_MS: '0' });
    const g = (await healthDetails(s.baseUrl)).system.memoryGuard;
    assert.equal(g.softLimitMb, 307, JSON.stringify(g));
    assert.equal(g.reservedForRendersMb, 512);
    assert.equal(g.source, 'computed');
    const token = s.signFirebaseToken({ sub: 'c6-user' });
    const readyIs = async (want: number) => {
      for (let i = 0; i < 40; i++) {
        if ((await fetch(`${s.baseUrl}/api/ready`)).status === want) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`readiness never became ${want}`);
    };
    await readyIs(200);
    fs.writeFileSync(rssFile, '320'); // Node at 320 MB: fine for the old 819 MB threshold, NOT with two renders running
    await readyIs(503);
    const render = await send(s, { path: '/api/render/video', token, body: json({ title: 'x', duration: 5, beats: [{ text: 'hi', start_s: 0, end_s: 2 }] }) });
    assert.equal(render.status, 503);
    assert.equal(render.body?.code, 'memory_pressure');
    fs.writeFileSync(rssFile, '290'); // below 307 but above 90 % (276): still guarded
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await fetch(`${s.baseUrl}/api/ready`)).status, 503);
    fs.writeFileSync(rssFile, '250');
    await readyIs(200);
  });

  test('a configured reserve and an explicit override are used (no double counting)', async () => {
    const a = await boot({ MEMORY_CONTAINER_LIMIT_MB: '1024', MAX_CONCURRENT_RENDERS: '2', RENDER_MEMORY_RESERVE_MB: '128' });
    assert.equal((await healthDetails(a.baseUrl)).system.memoryGuard.softLimitMb, 563);
    const b = await boot({ MEMORY_CONTAINER_LIMIT_MB: '1024', MAX_CONCURRENT_RENDERS: '2', MEMORY_SOFT_LIMIT_MB: '700' });
    const gb = (await healthDetails(b.baseUrl)).system.memoryGuard;
    assert.deepEqual([gb.softLimitMb, gb.source, gb.reservedForRendersMb], [700, 'explicit', 0]);
  });

  test('an insufficient memory budget makes the server refuse to start with a clear message', async () => {
    await assert.rejects(boot({ MEMORY_CONTAINER_LIMIT_MB: '512', MAX_CONCURRENT_RENDERS: '2' }), /insufficient memory budget/);
    await assert.rejects(boot({ MEMORY_CONTAINER_LIMIT_MB: '1024', MAX_CONCURRENT_RENDERS: 'abc' }), /MAX_CONCURRENT_RENDERS/);
  });
});

describe('Correction 2: recovery from REAL memory pressure (no injected RSS)', () => {
  /** Retains / releases genuine memory inside the server process (test-only hook, refused outside NODE_ENV=test). */
  const hook = async (s: TestServer, body: Record<string, unknown>) =>
    (await fetch(`${s.baseUrl}/__test/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  test('retained buffers push real RSS over the limit: guard on, readiness 503; after release + GC readiness returns only once real RSS < 90 %', async () => {
    const s = await boot({ NODE_OPTIONS: '--expose-gc', MEMORY_TEST_HOOKS: '1', MEMORY_SOFT_LIMIT_MB: '400', MEMORY_SAMPLE_MS: '200', READY_CACHE_MS: '0' });
    const token = s.signFirebaseToken({ sub: 'c7-user' });
    const base = (await healthDetails(s.baseUrl)).system;
    assert.ok(base.rssMb < 360, `baseline RSS ${base.rssMb} MB leaves room under the 400 MB limit`);
    assert.equal((await fetch(`${s.baseUrl}/api/ready`)).status, 200);

    const held = await hook(s, { retainMb: 450 });
    assert.ok(held.rssMb > 400, `real RSS after retaining 450 MB: ${held.rssMb} MB`);
    // guard on (from the sampler's real reading) and readiness drained
    let pressured: any = null;
    for (let i = 0; i < 30 && !pressured; i++) {
      const d = await healthDetails(s.baseUrl);
      if (d.system.memoryGuard.pressured) pressured = d.system;
      else await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pressured, 'the guard tripped on real RSS');
    assert.ok(pressured.memoryGuard.lastRssMb > 400);
    const ready = await fetch(`${s.baseUrl}/api/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).checks.memory, false);
    const big = await send(s, { path: '/api/projects', token, body: sized(200_000, 'notes', { title: 'under real pressure' }) });
    assert.equal(big.status, 503);
    assert.equal(big.body?.code, 'memory_pressure');

    // release and collect; then readiness may only come back when the REAL reading is below 90 % of the limit
    const released = await hook(s, { release: true });
    const observations: Array<{ t: number; ready: number; lastRssMb: number; pressured: boolean }> = [];
    const t0 = Date.now();
    let recovered = false;
    while (Date.now() - t0 < 20_000) {
      const d = await healthDetails(s.baseUrl);
      const r = (await fetch(`${s.baseUrl}/api/ready`)).status;
      observations.push({ t: Date.now() - t0, ready: r, lastRssMb: d.system.memoryGuard.lastRssMb, pressured: d.system.memoryGuard.pressured });
      if (r === 200) {
        recovered = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    console.log(JSON.stringify({ event: 'c7_real_recovery', baselineRssMb: base.rssMb, heldRssMb: held.rssMb, afterReleaseRssMb: released.rssMb, recovered, observations: observations.slice(-5), polls: observations.length }));
    assert.ok(recovered, `readiness did not recover within 20 s; last real RSS ${observations.at(-1)?.lastRssMb} MB vs recovery threshold 360 MB`);
    const last = observations.at(-1)!;
    assert.ok(last.lastRssMb < 360, `recovered only below 90 % of the limit (real RSS ${last.lastRssMb} MB)`);
    for (const o of observations.slice(0, -1)) assert.equal(o.ready, 503, 'never ready while the guard still saw RSS at or above the recovery threshold');
    assert.equal((await send(s, { path: '/api/projects', token, body: sized(200_000, 'notes', { title: 'after real recovery' }) })).status, 200);
  });

  test('the memory test hook does not exist unless NODE_ENV=test and MEMORY_TEST_HOOKS=1', async () => {
    const s = await boot();
    const r = await fetch(`${s.baseUrl}/__test/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"retainMb":10}' });
    assert.notEqual(r.status, 200);
  });
});
