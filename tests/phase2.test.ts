// Phase 2 validation gate (real PostgreSQL, real server processes, real CLIs).
// Requires TEST_DATABASE_URL; with REQUIRE_PG_TESTS=1 (CI) a missing database is a failure, not a skip.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startTestServer, guestToken, healthDetails, type TestServer } from './helpers/server.ts';
import { createTestDatabase, pgSkip, PG_ADMIN_URL, type TestDb } from './helpers/pg.ts';
import { startGeminiStub } from './helpers/geminiStub.ts';
import { startS3Stub } from './helpers/s3Stub.ts';
import { startTcpProxy } from './helpers/tcpProxy.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // shared so guest tokens stay valid across servers

async function boot(env: Record<string, string>) {
  const s = await startTestServer({ SESSION_SECRET, ...env });
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await s.stop();
    }
  };
  cleanups.push(stop);
  return Object.assign(s, { stopNow: stop });
}
async function freshDb() {
  const d = await createTestDatabase({ migrate: false });
  cleanups.push(() => d.drop());
  return d;
}
const call = (s: TestServer, p: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${s.baseUrl}${p}`, { ...init, headers });
};
const post = (s: TestServer, p: string, token: string, body: unknown) => call(s, p, token, { method: 'POST', body: JSON.stringify(body) });
const titles = async (s: TestServer, token: string) =>
  ((await (await call(s, '/api/projects', token)).json()).projects as any[]).filter((p) => !p.isSample).map((p) => p.title).sort();
// Async on purpose: the CLIs talk to stubs (S3) running inside this test process; blocking here (spawnSync)
// would deadlock them.
function cli(script: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
async function q(db: TestDb, sql: string, params: any[] = []) {
  const c = new pg.Client({ connectionString: db.url.replace(/[?&]sslmode=disable/, '') });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

describe('Gate 1-3: JSON -> PostgreSQL migration, ownership, idempotency, rollback', { skip: pgSkip }, () => {
  test('migrates guest and signed-in users\' data with exact ownership; dry run changes nothing; re-run is idempotent; rollback keeps post-migration writes', async () => {
    // 1. Produce a realistic JSON store through the real API (JSON backend).
    const dataDir = tmpDir('p2-json-');
    let js = await boot({ STORAGE_BACKEND: 'json', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0' });
    const alice = js.signFirebaseToken({ sub: 'mig-alice' });
    const bob = js.signFirebaseToken({ sub: 'mig-bob' });
    const guest = await guestToken(js.baseUrl);
    for (const t of ['Alice A', 'Alice B', 'Alice C']) assert.equal((await post(js, '/api/projects', alice, { title: t, script: { beats: [{ id: 'b', text: `${t} ünïcødé 🎬`, start_s: 0.25 }] } })).status, 200);
    assert.equal((await post(js, '/api/projects', bob, { title: 'Bob A' })).status, 200);
    for (const t of ['Guest A', 'Guest B']) assert.equal((await post(js, '/api/projects', guest, { title: t })).status, 200);
    assert.equal((await post(js, '/api/publish/generate-pack', guest, { beats: [] })).status, 200);
    await js.stopNow();

    const db = await freshDb();
    const env = { DATA_DIR: dataDir, DATABASE_URL: db.url };

    // 2. Dry run: full migration + verification, then rollback => database still empty.
    const plan = await cli('scripts/data-migration.ts', ['plan'], env);
    assert.equal(plan.status, 0, plan.stderr);
    const planReport = JSON.parse(plan.stdout);
    assert.equal(planReport.dryRun, true);
    assert.equal(planReport.source.projects, 6);
    assert.equal(planReport.source.guestProjects, 2);
    assert.equal(planReport.verification.ok, true);
    assert.equal((await q(db, 'SELECT count(*)::int AS n FROM projects'))[0].n, 0, 'dry run left nothing behind');

    // 3. Real migration.
    const run1 = await cli('scripts/data-migration.ts', ['migrate'], env);
    assert.equal(run1.status, 0, run1.stderr);
    const r1 = JSON.parse(run1.stdout);
    assert.deepEqual([r1.inserted.projects, r1.alreadyPresent.projects, r1.verification.missing.length, r1.verification.wrongOwner.length], [6, 0, 0, 0]);
    assert.ok(r1.snapshot, 'verified JSON snapshot taken before migrating');
    // ownership in the database, per user
    const owners = await q(db, 'SELECT user_id, count(*)::int AS n FROM projects GROUP BY user_id ORDER BY user_id');
    const byOwner = Object.fromEntries(owners.map((o: any) => [o.user_id, o.n]));
    assert.equal(byOwner['mig-alice'], 3);
    assert.equal(byOwner['mig-bob'], 1);
    assert.equal(Object.entries(byOwner).find(([u]) => u.startsWith('guest_'))?.[1], 2);
    const counters = await q(db, "SELECT u.id, u.project_count, u.storage_bytes, (SELECT coalesce(sum(size_bytes),0) FROM projects p WHERE p.user_id = u.id) AS real FROM users u");
    for (const c of counters) assert.equal(String(c.storage_bytes), String(c.real), `quota counter exact for ${c.id}`);
    // the JSON source is untouched
    assert.ok(fs.existsSync(path.join(dataDir, 'projects')));

    // 4. Serve from PostgreSQL: everyone sees exactly their own projects, content intact.
    const pgs = await boot({ DATA_DIR: tmpDir('p2-pgdata-'), DATABASE_URL: db.url });
    const a2 = pgs.signFirebaseToken({ sub: 'mig-alice' });
    const b2 = pgs.signFirebaseToken({ sub: 'mig-bob' });
    assert.deepEqual(await titles(pgs, a2), ['Alice A', 'Alice B', 'Alice C']);
    assert.deepEqual(await titles(pgs, b2), ['Bob A']);
    assert.deepEqual(await titles(pgs, guest), ['Guest A', 'Guest B'], 'guest token still works and sees its projects');
    const aliceList = (await (await call(pgs, '/api/projects', a2)).json()).projects.filter((p: any) => !p.isSample);
    assert.equal(aliceList.find((p: any) => p.title === 'Alice A').script.beats[0].text, 'Alice A ünïcødé 🎬');
    const bobProject = (await (await call(pgs, '/api/projects', b2)).json()).projects[0];
    assert.equal((await call(pgs, `/api/projects/${bobProject.id}`, a2)).status, 404, 'isolation preserved');

    // 5. A write made in PostgreSQL, then the migration is re-run: idempotent, newer write kept.
    const edited = await post(pgs, '/api/projects', a2, { id: aliceList[0].id, title: 'Alice edited in PG' });
    assert.equal(edited.status, 200);
    assert.equal((await post(pgs, '/api/projects', a2, { title: 'Alice new in PG' })).status, 200);
    const run2 = await cli('scripts/data-migration.ts', ['migrate', '--force'], env);
    assert.equal(run2.status, 0, run2.stderr);
    const r2 = JSON.parse(run2.stdout);
    assert.deepEqual([r2.inserted.projects, r2.alreadyPresent.projects], [0, 6]);
    assert.deepEqual(r2.diverged, [aliceList[0].id], 'the PG-side edit is detected and kept');
    assert.ok((await titles(pgs, a2)).includes('Alice edited in PG'));

    // 6. Rollback: export PostgreSQL -> new JSON dir, serve it with the JSON backend.
    await pgs.stopNow();
    const rollbackDir = path.join(tmpDir('p2-rb-'), 'data');
    const exp = await cli('scripts/data-migration.ts', ['export', rollbackDir], env);
    assert.equal(exp.status, 0, exp.stderr);
    assert.equal(JSON.parse(exp.stdout).verified, true);
    js = await boot({ STORAGE_BACKEND: 'json', DATA_DIR: rollbackDir, BACKUP_INTERVAL_HOURS: '0' });
    const a3 = js.signFirebaseToken({ sub: 'mig-alice' });
    const expectedAlice = ['Alice A', 'Alice B', 'Alice C'].filter((t) => t !== aliceList[0].title).concat(['Alice edited in PG', 'Alice new in PG']).sort();
    assert.deepEqual(await titles(js, a3), expectedAlice, 'rollback keeps writes made after go-live');
    assert.deepEqual(await titles(js, guest), ['Guest A', 'Guest B']);
    // export refuses to overwrite
    assert.equal((await cli('scripts/data-migration.ts', ['export', rollbackDir], env)).status, 1);
  });

  test('a corrupt source shard aborts the migration; nothing is written', async () => {
    const dataDir = tmpDir('p2-bad-');
    const js = await boot({ STORAGE_BACKEND: 'json', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0' });
    const u = js.signFirebaseToken({ sub: 'bad-user' });
    await post(js, '/api/projects', u, { title: 'x' });
    await post(js, '/api/projects', js.signFirebaseToken({ sub: 'ok-user' }), { title: 'y' });
    await js.stopNow();
    fs.appendFileSync(path.join(dataDir, 'projects', 'bad-user.json'), '{trunc');
    const db = await freshDb();
    const r = await cli('scripts/data-migration.ts', ['migrate'], { DATA_DIR: dataDir, DATABASE_URL: db.url });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /corrupt/);
    assert.equal((await q(db, 'SELECT count(*)::int AS n FROM projects'))[0].n, 0);
  });
});

describe('Gate 4-7: two instances on one database', { skip: pgSkip }, () => {
  test('shared rate limits, guest-mint budget, concurrent writes, isolation, AI quota across instances and restarts', async () => {
    const stub = await startGeminiStub();
    cleanups.push(() => stub.close());
    stub.delayMs = 300;
    const db = await freshDb();
    const env = {
      DATABASE_URL: db.url,
      GEMINI_API_KEY: 'stub-key-0123456789',
      GEMINI_BASE_URL: stub.baseUrl,
      GEMINI_MODELS: 'stub-model',
      FREE_DAILY_AI_QUOTA: '3',
      GUEST_MINT_PER_HOUR: '4',
      GUEST_MAX_PROJECTS: '5',
    };
    let A = await boot({ ...env, DATA_DIR: tmpDir('p2-a-') });
    let B = await boot({ ...env, DATA_DIR: tmpDir('p2-b-') });
    const both = () => [A, B];

    // Gate 6: guest-mint budget is global, not per instance
    const mints: number[] = [];
    for (let i = 0; i < 6; i++) mints.push((await fetch(`${both()[i % 2].baseUrl}/api/auth/guest`, { method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${i}` } })).status);
    assert.deepEqual(mints, [200, 200, 200, 200, 429, 429]);

    // Gate 6: per-user rate limit shared (publish: 30/min). 40 requests alternating between instances.
    const user = A.signFirebaseToken({ sub: 'multi-user' });
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await post(both()[i % 2], '/api/publish/generate-pack', user, { beats: [] })).status);
    assert.equal(codes.filter((c) => c === 200).length, 30, `exactly the per-user limit across both instances: ${codes.join(',')}`);

    // Gate 4: concurrent writes from both instances; quota exact
    const writer = A.signFirebaseToken({ sub: 'writer' });
    const saves = await Promise.all(Array.from({ length: 20 }, (_, i) => post(both()[i % 2], '/api/projects', writer, { title: `w${i}` })));
    assert.ok(saves.every((r) => r.status === 200));
    const rows = await q(db, "SELECT count(*)::int AS n, (SELECT project_count FROM users WHERE id = 'writer') AS pc FROM projects WHERE user_id = 'writer'");
    assert.equal(rows[0].n, 20);
    assert.equal(rows[0].pc, 20, 'counter consistent after concurrent cross-instance writes');
    // concurrent updates of ONE project from both instances: one row, last writer wins, no corruption
    const pid = (await saves[0].json()).project.id;
    const ups = await Promise.all(Array.from({ length: 10 }, (_, i) => post(both()[i % 2], '/api/projects', writer, { id: pid, title: `edit-${i}` })));
    assert.ok(ups.every((r) => r.status === 200));
    const one = await q(db, 'SELECT count(*)::int AS n, max(title) AS t FROM projects WHERE id = $1', [pid]);
    assert.equal(one[0].n, 1);
    assert.match(one[0].t, /^edit-\d$/);

    // Gate 5: isolation across instances
    const other = B.signFirebaseToken({ sub: 'other-user' });
    assert.equal((await call(B, `/api/projects/${pid}`, other)).status, 404);
    assert.equal((await call(A, `/api/projects/${pid}`, other, { method: 'DELETE' })).status, 404);
    assert.equal((await post(B, '/api/projects', other, { id: pid, title: 'hijack' })).status, 404);
    assert.equal((await q(db, 'SELECT user_id FROM projects WHERE id = $1', [pid]))[0].user_id, 'writer');

    // Gate 7: AI quota (3/day) with 10 concurrent requests spread over both instances
    const aiUser = A.signFirebaseToken({ sub: 'ai-user' });
    stub.calls = 0;
    const ai = await Promise.all(Array.from({ length: 10 }, (_, i) => post(both()[i % 2], '/api/gemini/suggest-hooks', aiUser, { topic: 'sleep' })));
    const bodies = await Promise.all(ai.map((r) => r.json()));
    assert.equal(ai.filter((r, i) => r.status === 200 && bodies[i].isFallback === false).length, 3, `statuses ${ai.map((r) => r.status)}`);
    assert.equal(ai.filter((r) => r.status === 429).length, 7);
    assert.equal(stub.calls, 3, 'model called exactly as often as the quota allows across instances');

    // Gate 7: survives restart of BOTH instances
    await A.stopNow();
    await B.stopNow();
    A = await boot({ ...env, DATA_DIR: tmpDir('p2-a2-') });
    B = await boot({ ...env, DATA_DIR: tmpDir('p2-b2-') });
    const aiUser2 = A.signFirebaseToken({ sub: 'ai-user' });
    assert.equal((await (await call(B, '/api/quota', aiUser2)).json()).dailyQuotaUsed, 3);
    assert.equal((await post(A, '/api/gemini/suggest-hooks', aiUser2, { topic: 'x' })).status, 429);
    assert.equal((await post(B, '/api/gemini/suggest-hooks', aiUser2, { topic: 'x' })).status, 429);
  });

  test('render jobs: created on one instance, cancelled from the other; admission is atomic across instances', async () => {
    const db = await freshDb();
    const env = { DATABASE_URL: db.url, MAX_CONCURRENT_RENDERS: '1', FREE_MONTHLY_RENDER_MINUTES: '100', JOB_HEARTBEAT_MS: '200' };
    const A = await boot({ ...env, DATA_DIR: tmpDir('p2-ja-') });
    const B = await boot({ ...env, DATA_DIR: tmpDir('p2-jb-') });
    const u = A.signFirebaseToken({ sub: 'job-user' });
    // atomic admission: 12 concurrent creates over both instances, cap is 5 active jobs
    const creates = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post([A, B][i % 2], '/api/jobs/create', u, { type: 'render_video', payload: { duration: 60, resolution: '1080p' } })),
    );
    assert.equal(creates.filter((r) => r.status === 200).length, 5, `statuses ${creates.map((r) => r.status)}`);
    assert.equal(creates.filter((r) => r.status === 429).length, 7);
    const ids = await Promise.all(creates.filter((r) => r.status === 200).map(async (r) => (await r.json()).job.id));
    // cancel everything through B, wherever it runs; nothing may complete afterwards
    for (const id of ids) assert.equal((await post(B, `/api/jobs/${id}/cancel`, u, {})).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    const states = await q(db, 'SELECT status, result FROM jobs WHERE user_id = $1', ['job-user']);
    assert.ok(states.every((s: any) => s.status === 'cancelled' && s.result === null), JSON.stringify(states));
  });
});

describe('Gate 8: encrypted off-site backup restored into a real database', { skip: pgSkip }, () => {
  test('pg_dump | age -> S3 -> verify -> restore into a new database -> the application serves the restored data', async () => {
    const s3 = await startS3Stub();
    cleanups.push(() => s3.close());
    const keyDir = tmpDir('p2-age-');
    execFileSync('age-keygen', ['-o', path.join(keyDir, 'key.txt')], { stdio: 'ignore' });
    const pub = /public key: (age1\w+)/.exec(fs.readFileSync(path.join(keyDir, 'key.txt'), 'utf8'))![1];
    const db = await freshDb();
    const s = await boot({ DATA_DIR: tmpDir('p2-bk-'), DATABASE_URL: db.url });
    const u = s.signFirebaseToken({ sub: 'backup-user' });
    for (const t of ['Keep 1', 'Keep 2', 'SECRET-PLAINTEXT-MARKER']) assert.equal((await post(s, '/api/projects', u, { title: t })).status, 200);

    const env = {
      DATABASE_URL: db.url,
      BACKUP_TARGET: 's3://forge-offsite/prod',
      S3_ENDPOINT: s3.endpoint,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      BACKUP_AGE_RECIPIENTS: pub,
    };
    const created = await cli('scripts/db-backup.ts', ['create'], env);
    assert.equal(created.status, 0, created.stderr);
    const name = JSON.parse(created.stdout).created;
    const blob = [...s3.objects.entries()].find(([k]) => k.endsWith('.dump.age'))![1];
    assert.ok(!blob.includes('SECRET-PLAINTEXT-MARKER'), 'off-site object is encrypted');
    assert.ok(blob.subarray(0, 40).toString().startsWith('age-encryption.org/v1'));
    assert.equal((await cli('scripts/db-backup.ts', ['create'], { ...env, BACKUP_AGE_RECIPIENTS: '' })).status, 1, 'refuses to create an unencrypted backup');

    // disaster: all projects deleted in the live database
    await q(db, 'DELETE FROM projects');
    assert.deepEqual(await titles(s, u), []);

    // restore into a NEW database (never the live one)
    const target = await freshDb();
    const restoreEnv = { ...env, BACKUP_AGE_IDENTITY_FILE: path.join(keyDir, 'key.txt') };
    assert.equal((await cli('scripts/db-backup.ts', ['restore', name, db.url], restoreEnv)).status, 1, 'refuses a non-empty target');
    assert.equal((await cli('scripts/db-backup.ts', ['restore', name, target.url], { ...env })).status, 1, 'needs the private key');
    const restored = await cli('scripts/db-backup.ts', ['restore', name, target.url], restoreEnv);
    assert.equal(restored.status, 0, restored.stderr);
    const rr = JSON.parse(restored.stdout);
    assert.equal(rr.verified, true);
    assert.equal(rr.rowCounts.projects, 3);

    // switch the application to the restored database
    await s.stopNow();
    const s2 = await boot({ DATA_DIR: tmpDir('p2-bk2-'), DATABASE_URL: target.url });
    const u2 = s2.signFirebaseToken({ sub: 'backup-user' });
    assert.deepEqual(await titles(s2, u2), ['Keep 1', 'Keep 2', 'SECRET-PLAINTEXT-MARKER']);
    assert.equal((await post(s2, '/api/projects', u2, { title: 'after restore' })).status, 200, 'restored database is writable (schema + counters intact)');

    // tampering is detected
    const key = [...s3.objects.keys()].find((k) => k.endsWith('.dump.age'))!;
    s3.objects.get(key)![100] ^= 0xff;
    const v = await cli('scripts/db-backup.ts', ['verify', name], env);
    assert.equal(v.status, 1);
    assert.match(v.stderr, /checksum mismatch/);
  });
});

describe('Gate 9: database failure and recovery', { skip: pgSkip }, () => {
  test('outage -> fast 503s (no crash, no hang) -> automatic recovery without restart; no data lost', async () => {
    const db = await freshDb();
    const admin = new URL(PG_ADMIN_URL);
    const proxy = await startTcpProxy(admin.hostname, Number(admin.port || 5432));
    cleanups.push(() => proxy.close());
    const viaProxy = new URL(db.url);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    const s = await boot({ DATA_DIR: tmpDir('p2-out-'), DATABASE_URL: viaProxy.toString(), DATABASE_CONNECT_TIMEOUT_MS: '1000', DATABASE_STATEMENT_TIMEOUT_MS: '2000' });
    const u = s.signFirebaseToken({ sub: 'outage-user' });
    assert.equal((await post(s, '/api/projects', u, { title: 'before outage' })).status, 200);

    await proxy.down();
    const t0 = Date.now();
    const during = await post(s, '/api/projects', u, { title: 'during outage' });
    assert.equal(during.status, 503);
    assert.equal((await during.json()).code, 'database_unavailable');
    assert.ok(Date.now() - t0 < 5000, `failed fast (${Date.now() - t0} ms)`);
    assert.equal((await call(s, '/api/projects', u)).status, 503);
    assert.equal((await call(s, '/api/ready')).status, 503, 'instance leaves the load balancer rotation');
    const health = await call(s, '/api/health');
    assert.equal(health.status, 200, 'process alive (liveness has no dependencies)');
    assert.equal((await healthDetails(s.baseUrl)).storage.ok, false, 'diagnostics report the database down');

    await proxy.up();
    let recovered = false;
    for (let i = 0; i < 40 && !recovered; i++) {
      recovered = (await call(s, '/api/ready')).status === 200;
      if (!recovered) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(recovered, 'readiness recovered without a restart');
    assert.equal((await post(s, '/api/projects', u, { title: 'after outage' })).status, 200);
    assert.deepEqual(await titles(s, u), ['after outage', 'before outage'], 'nothing lost; the failed write was not half-applied');
    assert.doesNotMatch(s.logs(), /uncaught_exception|unhandled_rejection/);
  });

  test('server waits for the database at startup and fails clearly if it never comes', async () => {
    const proxy = await startTcpProxy('127.0.0.1', 1); // nothing listens upstream
    cleanups.push(() => proxy.close());
    await proxy.down();
    const url = `postgres://postgres@127.0.0.1:${proxy.port}/nope?sslmode=disable`;
    await assert.rejects(
      startTestServer({ SESSION_SECRET, DATABASE_URL: url, DATABASE_CONNECT_TIMEOUT_MS: '200', DATABASE_STARTUP_RETRIES: '3' }),
      (e: any) => /database_not_ready/.test(e.message) && /Failed to start server/.test(e.message),
    );
  });
});

describe('Configuration', () => {
  test('production requires DATABASE_URL or an explicit STORAGE_BACKEND=json', async () => {
    await assert.rejects(startTestServer({ NODE_ENV: 'production', TRUST_PROXY: 'none', DATABASE_URL: '', STORAGE_BACKEND: '' }), (e: any) => /Production requires DATABASE_URL/.test(e.message));
    await assert.rejects(startTestServer({ STORAGE_BACKEND: 'postgres', DATABASE_URL: '' }), (e: any) => /requires DATABASE_URL/.test(e.message));
  });
});
