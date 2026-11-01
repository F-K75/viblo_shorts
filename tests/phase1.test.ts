// Phase 1 regression tests (validation gate). Real server processes, real HTTP, real files.
// Each test reproduces an issue from docs/RELEASE_ASSESSMENT.md and proves the fix.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, guestToken, type TestServer } from './helpers/server.ts';
import { startGeminiStub } from './helpers/geminiStub.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const KB = 1024;
const servers: TestServer[] = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});
async function boot(env: Record<string, string> = {}) {
  const s = await startTestServer(env);
  servers.push(s);
  return s;
}
async function stopServer(s: TestServer) {
  await s.stop();
  servers.splice(servers.indexOf(s), 1);
}
const call = (s: TestServer, p: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${s.baseUrl}${p}`, { ...init, headers });
};
const save = (s: TestServer, token: string, body: unknown) => call(s, '/api/projects', token, { method: 'POST', body: JSON.stringify(body) });
const guestIdOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub as string;
const big = (kb: number) => 'x'.repeat(kb * KB);
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95) - 1] ?? xs[xs.length - 1];
async function latencies(s: TestServer, token: string, n = 20) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await call(s, '/api/projects', token);
    await r.arrayBuffer();
    out.push(performance.now() - t0);
  }
  return out;
}
const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-p1-'));

describe('FS-001 storage abuse', () => {
  test('guest byte quota, project cap, guest pool cap; authenticated users unaffected; >1 MB bodies rejected', async () => {
    const s = await boot({ GUEST_MAX_STORAGE_MB: '2', GUEST_POOL_MAX_MB: '3', GUEST_MAX_PROJECTS: '10' });
    // 1. a single guest cannot exceed 2 MB
    const g1 = await guestToken(s.baseUrl);
    const codes1: number[] = [];
    for (let i = 0; i < 8; i++) codes1.push((await save(s, g1, { title: `g1-${i}`, topic: big(450) })).status);
    assert.deepEqual(codes1.slice(0, 4), [200, 200, 200, 200]);
    const rejected = await save(s, g1, { title: 'g1-more', topic: big(450) });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'storage_quota_exceeded');
    // 2. guests collectively cannot exceed the guest pool (3 MB)
    const g2 = await guestToken(s.baseUrl);
    let poolFull: any = null;
    for (let i = 0; i < 6 && !poolFull; i++) {
      const r = await save(s, g2, { title: `g2-${i}`, topic: big(450) });
      if (r.status !== 200) poolFull = { status: r.status, ...(await r.json()) };
    }
    assert.equal(poolFull?.status, 507);
    assert.equal(poolFull?.code, 'guest_storage_full');
    // 3. authenticated users can still save
    const user = s.signFirebaseToken({ sub: 'real-user-1' });
    assert.equal((await save(s, user, { title: 'mine', topic: big(450) })).status, 200);
    // 4. project-count cap for guests
    const g3 = await guestToken(s.baseUrl);
    const codes3: number[] = [];
    for (let i = 0; i < 11; i++) codes3.push((await save(s, g3, { title: `tiny-${i}` })).status);
    assert.equal(codes3.filter((c) => c === 200).length, 10);
    assert.equal(codes3[10], 409);
    // 5. existing data can still be edited/deleted when at the limit
    const list = (await (await call(s, '/api/projects', g1)).json()).projects.filter((p: any) => !p.isSample);
    assert.equal((await save(s, g1, { id: list[0].id, title: 'shrunk', topic: 'small now' })).status, 200);
    assert.equal((await call(s, `/api/projects/${list[1].id}`, g1, { method: 'DELETE' })).status, 200);
    // 6. request body limit
    const huge = await call(s, '/api/projects', user, { method: 'POST', body: JSON.stringify({ title: 't', topic: big(1100) }) });
    assert.equal(huge.status, 413);
    // 7. single project size limit
    const tooBig = await save(s, user, { title: 't', topic: big(600) });
    assert.equal(tooBig.status, 413);
  });

  test('guest minting has a global hourly budget (rotating/spoofed IPs cannot mint unbounded accounts)', async () => {
    const s = await boot({ GUEST_MINT_PER_HOUR: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    const r = await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST' });
    assert.equal((await r.json()).code, 'guest_capacity');
  });

  test('another user\'s storage consumption does not slow down a normal user (re-run of the original probe)', async (t) => {
    const s = await boot({ GUEST_MAX_STORAGE_MB: '5', GUEST_MAX_PROJECTS: '10', GUEST_MINT_PER_HOUR: '1000' });
    const victim = s.signFirebaseToken({ sub: 'victim-user' });
    await save(s, victim, { title: 'my short' });
    await latencies(s, victim, 5); // warm-up
    const before = await latencies(s, victim);
    // 6 attackers x 9 x 500 KB = ~27 MB of project data (the original probe used 30 MB on one file)
    for (let a = 0; a < 6; a++) {
      const g = await guestToken(s.baseUrl);
      for (let i = 0; i < 9; i++) {
        const r = await save(s, g, { title: `a${a}-${i}`, topic: big(500) });
        if (r.status !== 200) break;
      }
    }
    // Layout-agnostic size (works for the legacy single file too, so this test also measures the old code).
    const dirBytes = (d: string): number => (fs.existsSync(d) ? fs.readdirSync(d).reduce((acc, f) => acc + fs.statSync(path.join(d, f)).size, 0) : 0);
    const legacyFile = path.join(s.dataDir, 'projects.json');
    const totalMb = (dirBytes(path.join(s.dataDir, 'projects')) + (fs.existsSync(legacyFile) ? fs.statSync(legacyFile).size : 0)) / 1e6;
    const afterL = await latencies(s, victim);
    const vList = (await (await call(s, '/api/projects', victim)).json()).projects;
    t.diagnostic(`store size ${totalMb.toFixed(1)} MB; victim p95 before ${p95(before).toFixed(1)} ms, after ${p95(afterL).toFixed(1)} ms`);
    assert.ok(totalMb > 20, 'attackers really stored a lot of data');
    assert.deepEqual(vList.map((p: any) => p.title), ['my short', 'Steve Jobs: Follow Your Intuition'], 'victim sees only own data');
    // Before the fix this was ~140 ms at 30 MB (linear in total data). Generous bound to stay CI-stable.
    assert.ok(p95(afterL) < 40, `victim p95 ${p95(afterL).toFixed(1)} ms should be unaffected by other users' data`);
  });
});

describe('FS-002 corruption cannot cause global data loss', () => {
  test('a corrupt shard affects only its owner, is never overwritten; other users keep saving', async () => {
    const s = await boot();
    const a = await guestToken(s.baseUrl);
    const b = await guestToken(s.baseUrl);
    for (let i = 0; i < 3; i++) assert.equal((await save(s, a, { title: `A${i}` })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await save(s, b, { title: `B${i}` })).status, 200);
    // The file holding A's data: A's shard (new layout) or the single shared file (legacy layout).
    const shard = path.join(s.dataDir, 'projects', `${guestIdOf(a)}.json`);
    const aFile = fs.existsSync(shard) ? shard : path.join(s.dataDir, 'projects.json');
    fs.appendFileSync(aFile, '\n{trunc'); // the exact corruption from the Phase 0 probe
    const corruptBytes = fs.readFileSync(aFile);

    const aList = await call(s, '/api/projects', a);
    assert.equal(aList.status, 503);
    assert.equal((await aList.json()).code, 'store_unavailable');
    assert.equal((await save(s, a, { title: 'A-new' })).status, 503, 'writes refused for the corrupt shard');
    assert.deepEqual(fs.readFileSync(aFile), corruptBytes, 'corrupt shard byte-for-byte unchanged');

    assert.equal((await save(s, b, { title: 'B-new' })).status, 200, 'other users unaffected');
    const bList = (await (await call(s, '/api/projects', b)).json()).projects.filter((p: any) => !p.isSample);
    assert.equal(bList.length, 3);
    assert.equal((await call(s, '/api/ready')).status, 200, 'one corrupt user shard does not take the instance out of rotation');
    // forensic copy taken once, not per request
    for (let i = 0; i < 5; i++) await call(s, '/api/projects', a);
    assert.equal(fs.readdirSync(path.dirname(aFile)).filter((f) => f.includes('.corrupt-')).length, 1);
  });

  test('a corrupt shared store (jobs.json) fails closed: 503, readiness down, file untouched', async () => {
    const s = await boot();
    const a = await guestToken(s.baseUrl);
    const jobsFile = path.join(s.dataDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[{"id":"job_1","userId":"x"');
    assert.equal((await call(s, '/api/jobs', a)).status, 503);
    const create = await call(s, '/api/jobs/create', a, { method: 'POST', body: JSON.stringify({ type: 'render_video', payload: { duration: 2 } }) });
    assert.equal(create.status, 503);
    assert.equal(fs.readFileSync(jobsFile, 'utf8'), '[{"id":"job_1","userId":"x"');
    const ready = await call(s, '/api/ready');
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).checks.stores, false);
  });

  test('legacy single-file store: verified backup, migration to per-user shards, nothing lost', async () => {
    const dataDir = tmpDataDir();
    const legacy = [
      { id: 'proj_legacy_1', userId: 'legacy-alice', title: 'Alice 1', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'proj_legacy_2', userId: 'legacy-bob', title: 'Bob 1', updatedAt: '2026-10-02T00:00:00Z' },
      { id: 'proj_legacy_3', userId: 'legacy-alice', title: 'Alice 2', updatedAt: '2026-10-03T00:00:00Z' },
      { id: 'proj_legacy_4', title: 'No owner' },
    ];
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(legacy, null, 2));
    const s = await boot({ DATA_DIR: dataDir });
    const alice = s.signFirebaseToken({ sub: 'legacy-alice' });
    const bob = s.signFirebaseToken({ sub: 'legacy-bob' });
    const aTitles = (await (await call(s, '/api/projects', alice)).json()).projects.map((p: any) => p.title);
    assert.deepEqual(aTitles, ['Alice 2', 'Alice 1', 'Steve Jobs: Follow Your Intuition']);
    assert.equal((await call(s, '/api/projects/proj_legacy_2', bob)).status, 200);
    assert.equal((await call(s, '/api/projects/proj_legacy_2', alice)).status, 404, 'isolation preserved after migration');
    assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('projects.json.migrated-')), 'legacy file kept');
    const snaps = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.includes('pre-migration'));
    assert.equal(snaps.length, 1);
    const verify = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', 'verify', snaps[0]], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    await stopServer(s);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('corrupt legacy store: migration refused, file untouched, project routes 503', async () => {
    const dataDir = tmpDataDir();
    fs.writeFileSync(path.join(dataDir, 'projects.json'), '[{"id":"proj_1","userId":"u"');
    const s = await boot({ DATA_DIR: dataDir });
    const u = s.signFirebaseToken({ sub: 'u' });
    assert.equal((await call(s, '/api/projects', u)).status, 503);
    assert.equal((await save(s, u, { title: 'x' })).status, 503);
    assert.equal(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8'), '[{"id":"proj_1","userId":"u"');
    assert.equal((await call(s, '/api/ready')).status, 503);
    await stopServer(s);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('Backups', () => {
  test('snapshot -> user loses data -> restore (server stopped) -> original projects are back', async () => {
    const dataDir = tmpDataDir();
    const env = { DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0' };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });

    let s = await boot(env);
    let u = s.signFirebaseToken({ sub: 'restore-user' });
    const titles = ['Original A', 'Original B', 'Original C'];
    for (const title of titles) assert.equal((await save(s, u, { title })).status, 200);
    const created = cli('create');
    assert.equal(created.status, 0, created.stderr);
    const snapName = JSON.parse(created.stdout).created;

    // disaster: every project deleted
    for (const p of (await (await call(s, '/api/projects', u)).json()).projects.filter((p: any) => !p.isSample)) {
      await call(s, `/api/projects/${p.id}`, u, { method: 'DELETE' });
    }
    assert.equal((await (await call(s, '/api/projects', u)).json()).projects.length, 1, 'only the sample left');

    const whileRunning = cli('restore', snapName);
    assert.equal(whileRunning.status, 1, 'restore refused while the server is running');
    assert.match(whileRunning.stderr, /server may be running/);

    await stopServer(s);
    const restored = cli('restore', snapName);
    assert.equal(restored.status, 0, restored.stderr);
    const info = JSON.parse(restored.stdout);
    assert.ok(info.preRestoreSnapshot, 'state before restore was snapshotted');

    s = await boot(env);
    u = s.signFirebaseToken({ sub: 'restore-user' });
    const back = (await (await call(s, '/api/projects', u)).json()).projects.filter((p: any) => !p.isSample).map((p: any) => p.title).sort();
    assert.deepEqual(back, [...titles].sort());
    await stopServer(s);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('server takes a verified scheduled snapshot at startup and reports it in /api/health', async () => {
    const s = await boot();
    let backups: any = null;
    for (let i = 0; i < 20 && !backups?.last; i++) {
      backups = (await (await call(s, '/api/health')).json()).backups;
      if (!backups?.last) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(backups.last, JSON.stringify(backups));
    assert.equal(backups.lastError, null);
  });
});

describe('FS-007 AI quota', () => {
  test('concurrent requests cannot exceed the daily quota; usage survives a restart', async () => {
    const stub = await startGeminiStub();
    stub.delayMs = 400; // all requests are in flight at the same time
    const dataDir = tmpDataDir();
    const env = { DATA_DIR: dataDir, GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', FREE_DAILY_AI_QUOTA: '3' };
    let s = await boot(env);
    let u = s.signFirebaseToken({ sub: 'quota-user' });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => call(s, '/api/gemini/suggest-hooks', u, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }) })),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const ok = responses.filter((r, i) => r.status === 200 && bodies[i].isFallback === false);
    assert.equal(ok.length, 3, `statuses: ${responses.map((r) => r.status).join(',')}`);
    assert.equal(responses.filter((r) => r.status === 429).length, 7);
    assert.equal(stub.calls, 3, 'the model was called exactly as often as the quota allows');
    assert.equal((await (await call(s, '/api/quota', u)).json()).dailyQuotaUsed, 3);

    await stopServer(s); // SIGTERM flushes the ledger
    s = await boot(env);
    u = s.signFirebaseToken({ sub: 'quota-user' });
    assert.equal((await (await call(s, '/api/quota', u)).json()).dailyQuotaUsed, 3, 'usage persisted across restart');
    assert.equal((await call(s, '/api/gemini/suggest-hooks', u, { method: 'POST', body: JSON.stringify({ topic: 'x' }) })).status, 429);
    await stopServer(s);
    await stub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('failed AI calls, template fallbacks and invalid requests do not consume quota', async () => {
    const stub = await startGeminiStub();
    stub.mode = 'fail';
    const s = await boot({ GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', FREE_DAILY_AI_QUOTA: '2' });
    const u = s.signFirebaseToken({ sub: 'refund-user' });
    for (let i = 0; i < 4; i++) {
      const r = await call(s, '/api/gemini/suggest-hooks', u, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }) });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).isFallback, true);
    }
    assert.ok(stub.calls >= 4, 'the provider was really called and failed');
    const bad = await call(s, '/api/generate-script', u, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
    assert.equal((await (await call(s, '/api/quota', u)).json()).dailyQuotaUsed, 0, 'nothing charged');
    // and once the provider recovers, the full quota is available
    stub.mode = 'ok';
    const ok = await call(s, '/api/gemini/suggest-hooks', u, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }) });
    assert.equal((await ok.json()).isFallback, false);
    assert.equal((await (await call(s, '/api/quota', u)).json()).dailyQuotaUsed, 1);
    await stub.close();
  });
});

describe('FS-008 proxy configuration', () => {
  test('production refuses to start without an explicit TRUST_PROXY, and rejects TRUST_PROXY=true', async () => {
    for (const value of [undefined, 'true']) {
      const env: Record<string, string> = { NODE_ENV: 'production' };
      if (value) env.TRUST_PROXY = value;
      else env.TRUST_PROXY = '';
      await assert.rejects(startTestServer(env), (e: any) => /TRUST_PROXY/.test(e.message) && /exited early/.test(e.message));
    }
  });

  test('behind a trusted proxy, clients get separate IP buckets but one user cannot bypass limits by rotating X-Forwarded-For', async () => {
    const s = await boot({ TRUST_PROXY: '1' });
    const one = await guestToken(s.baseUrl);
    const codes: number[] = [];
    for (let i = 0; i < 18; i++) {
      const r = await call(s, '/api/generate-script', one, { method: 'POST', body: JSON.stringify({ topic: 'sleep' }), headers: { 'x-forwarded-for': `203.0.113.${i}` } });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), 'per-user bucket still applies');
    // different clients behind the proxy (distinct IPs) are not limited by each other's guest mints
    const mint = async (ip: string) => (await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST', headers: { 'x-forwarded-for': ip } })).status;
    const a: number[] = [];
    for (let i = 0; i < 12; i++) a.push(await mint('198.51.100.1'));
    assert.ok(a.includes(429), 'one client is limited');
    assert.equal(await mint('198.51.100.2'), 200, 'another client behind the same proxy is not');
  });

  test('X-Forwarded-For without TRUST_PROXY is detected and reported (misconfiguration signal)', async () => {
    const s = await boot();
    const g = await guestToken(s.baseUrl);
    await call(s, '/api/projects', g, { headers: { 'x-forwarded-for': '1.2.3.4' } });
    const h = await (await call(s, '/api/health')).json();
    assert.ok(h.proxy.untrustedForwardedRequests >= 1);
  });
});

describe('Crash scenarios and limit bypasses', () => {
  test('publishing pack: malformed beats no longer crash the server (FS-017)', async () => {
    const s = await boot();
    const g = await guestToken(s.baseUrl);
    const r1 = await call(s, '/api/publish/generate-pack', g, { method: 'POST', body: JSON.stringify({ beats: [null, 5, { text: 'ok', start_s: -10, end_s: 'x' }] }) });
    assert.equal(r1.status, 200);
    const pack = (await r1.json()).pack;
    assert.match(pack.srtContent, /^1\n00:00:00,000 --> 00:00:03,500\nok\n/);
    assert.equal((await call(s, '/api/publish/generate-pack', g, { method: 'POST', body: JSON.stringify({ beats: 'nope' }) })).status, 400);
  });

  test('job retry obeys the active-job cap; queued jobs reserve render minutes (FS-015)', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1', FREE_MONTHLY_RENDER_MINUTES: '2' });
    const g = await guestToken(s.baseUrl);
    const create = (duration: number) => call(s, '/api/jobs/create', g, { method: 'POST', body: JSON.stringify({ type: 'render_video', payload: { duration, resolution: '720p' } }) });
    // render minutes: 60 s + 50 s reserved => another 15 s job exceeds the 2-minute plan even before any completes
    const j1 = await (await create(60)).json();
    const j2 = await (await create(50)).json();
    assert.equal((await create(15)).status, 402);
    for (const j of [j1, j2]) await call(s, `/api/jobs/${j.job.id}/cancel`, g, { method: 'POST' });

    // active-job cap: cancel one, fill 5 active slots with short jobs, retry must be refused
    const s2 = await boot({ MAX_CONCURRENT_RENDERS: '1', FREE_MONTHLY_RENDER_MINUTES: '100' });
    const g2 = await guestToken(s2.baseUrl);
    const create2 = (duration: number) => call(s2, '/api/jobs/create', g2, { method: 'POST', body: JSON.stringify({ type: 'render_video', payload: { duration, resolution: '1080p' } }) });
    const x = await (await create2(60)).json();
    await call(s2, `/api/jobs/${x.job.id}/cancel`, g2, { method: 'POST' });
    const active: string[] = [];
    for (let i = 0; i < 5; i++) active.push((await (await create2(60)).json()).job.id);
    const retry = await call(s2, `/api/jobs/${x.job.id}/retry`, g2, { method: 'POST' });
    assert.equal(retry.status, 429, 'retry used to bypass the 5-active-jobs cap');
    for (const id of active) await call(s2, `/api/jobs/${id}/cancel`, g2, { method: 'POST' });
  });

  test('async route failures reach the error handler (no unhandled rejection, server keeps serving)', async () => {
    const s = await boot();
    const g = await guestToken(s.baseUrl);
    fs.writeFileSync(path.join(s.dataDir, 'subscriptions.json'), '{bad');
    // async handler that reads subscriptions before its first await
    const r = await call(s, '/api/render/video', g, { method: 'POST', body: JSON.stringify({ duration: 2 }) });
    assert.equal(r.status, 503);
    assert.equal((await call(s, '/api/health')).status, 200, 'process still alive');
    assert.doesNotMatch(s.logs(), /unhandled_rejection|UnhandledPromiseRejection/);
  });
});
