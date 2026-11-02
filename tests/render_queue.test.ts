// Track B (R-04, F7): render queue fairness, admission limits, exactly-once billing, timeouts and crash recovery.
// Real server processes and real ffmpeg renders (short ones). Multi-instance tests use PostgreSQL.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, guestToken, healthDetails, type TestServer } from './helpers/server.ts';
import { createTestDatabase, pgSkip } from './helpers/pg.ts';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
async function boot(env: Record<string, string> = {}) {
  const s = await startTestServer({ BACKUP_INTERVAL_HOURS: '0', SESSION_SECRET, JOB_HEARTBEAT_MS: '200', ...env });
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
const post = (s: TestServer, p: string, token: string, body: unknown = {}) =>
  fetch(`${s.baseUrl}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = async (s: TestServer, p: string, token: string) => (await fetch(`${s.baseUrl}${p}`, { headers: { authorization: `Bearer ${token}` } })).json();
/** A short render: `seconds` of 720p video. */
const job = (seconds = 2, title = 'q') => ({ type: 'render_video', payload: { title, duration: seconds, resolution: '720p', beats: [{ text: title, start_s: 0, end_s: 1 }] } });
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 200): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
}
/** ffmpeg processes that are children of the server process (zombies included: `ps` lists them as <defunct>). */
async function ffmpegChildren(s: TestServer) {
  const pid = Number(String((await healthDetails(s.baseUrl)).renders.instance).split(':')[1]);
  let out = '';
  try {
    out = execFileSync('ps', ['--ppid', String(pid), '-o', 'comm=,stat='], { encoding: 'utf8' });
  } catch {
    // ps exits 1 when there are no children
  }
  return out.split('\n').filter((l) => /ffmpeg/.test(l));
}
const minutesUsed = async (s: TestServer, token: string) => Number((await get(s, '/api/quota', token)).monthlyRenderMinutesUsed ?? (await get(s, '/api/user/subscription', token)).subscription?.monthlyRenderMinutesUsed);

describe('B2: guests cannot start server renders', () => {
  test('guest render, job and retry requests get 403 sign_in_required; nothing is queued or spawned', async () => {
    const s = await boot();
    const g = await guestToken(s.baseUrl);
    const direct = await post(s, '/api/render/video', g, job().payload);
    assert.equal(direct.status, 403);
    assert.equal((await direct.json()).code, 'sign_in_required');
    const queued = await post(s, '/api/jobs/create', g, job());
    assert.equal(queued.status, 403);
    assert.equal((await queued.json()).code, 'sign_in_required');
    assert.deepEqual((await get(s, '/api/jobs', g)).jobs, [], 'no job was created for the guest');
    assert.equal((await healthDetails(s.baseUrl)).renders.running, 0, 'no ffmpeg was spawned for the guest');
    assert.deepEqual(await ffmpegChildren(s), []);
    // guests keep everything else (projects)
    assert.equal((await post(s, '/api/projects', g, { title: 'guest project' })).status, 200);
  });
});

describe('B3: per-user and global admission limits (configurable)', () => {
  test('one user: at most 1 running + 3 queued; the 5th and 6th requests get 429 with a clear code', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '2' });
    const u = s.signFirebaseToken({ sub: 'b3-user' });
    const statuses: number[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(s, '/api/jobs/create', u, job(4, `u${i}`));
      statuses.push(r.status);
      codes.push((await r.json()).code);
    }
    assert.deepEqual(statuses.slice(0, 4), [200, 200, 200, 200], statuses.join(','));
    assert.deepEqual(statuses.slice(4), [429, 429], statuses.join(','));
    assert.deepEqual(codes.slice(4), ['user_queue_full', 'user_queue_full']);
    // with 2 render slots free, this user still runs only ONE job at a time
    await new Promise((r) => setTimeout(r, 800));
    const jobs = (await get(s, '/api/jobs', u)).jobs;
    assert.equal(jobs.filter((j: any) => j.status === 'processing').length, 1, JSON.stringify(jobs.map((j: any) => j.status)));
  });

  test('limits are configurable (RENDER_MAX_QUEUED_PER_USER=1)', async () => {
    const s = await boot({ RENDER_MAX_QUEUED_PER_USER: '1', MAX_CONCURRENT_RENDERS: '1' });
    const u = s.signFirebaseToken({ sub: 'b3-cfg' });
    const st = [];
    for (let i = 0; i < 3; i++) st.push((await post(s, '/api/jobs/create', u, job(4))).status);
    assert.deepEqual(st, [200, 200, 429]);
  });

  test('global queue cap across 2 instances: 300 users at once -> exactly RENDER_QUEUE_MAX queued, the rest 429 queue_full + Retry-After', { skip: pgSkip }, async () => {
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    // all requests come from one test IP: lift the per-IP rate limit so only the queue cap decides
    const env = { DATABASE_URL: db.url, RENDER_QUEUE_MAX: '25', MAX_CONCURRENT_RENDERS: '1', IP_RATE_MULTIPLIER: '100' };
    const A = await boot(env);
    const B = await boot(env);
    // occupy both workers with long renders so nothing leaves the queue during the burst
    const longA = await post(A, '/api/jobs/create', A.signFirebaseToken({ sub: 'b3-long-a' }), job(60, 'long'));
    const longB = await post(B, '/api/jobs/create', B.signFirebaseToken({ sub: 'b3-long-b' }), job(60, 'long'));
    assert.deepEqual([longA.status, longB.status], [200, 200]);
    await new Promise((r) => setTimeout(r, 1500));
    const results = await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        const s = i % 2 ? A : B;
        const r = await post(s, '/api/jobs/create', s.signFirebaseToken({ sub: `b3-burst-${i}` }), job(2));
        return { status: r.status, code: (await r.json()).code, retryAfter: r.headers.get('retry-after') };
      }),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter((r) => r.status === 429);
    assert.equal(ok, 25, `exactly the cap was admitted: ${results.map((r) => r.status).join(',')}`);
    assert.equal(full.length, 275, `statuses: ${[...new Set(results.map((r) => `${r.status}/${r.code}`))].join(' ')}`);
    assert.ok(full.every((r) => r.code === 'queue_full' && Number(r.retryAfter) > 0));
    const queued = (await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'")).rows[0].n;
    assert.equal(queued, 25, 'the database holds exactly the cap');
  });
});

describe('B4: fair scheduling (no starvation)', () => {
  test('one render slot: user A queues 3 jobs, then user B queues 1; B runs second, not last', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1' });
    const a = s.signFirebaseToken({ sub: 'b4-a' });
    const b = s.signFirebaseToken({ sub: 'b4-b' });
    const ids: Record<string, string> = {};
    for (const n of ['a1', 'a2', 'a3']) ids[n] = (await (await post(s, '/api/jobs/create', a, job(2, n))).json()).job.id;
    ids.b1 = (await (await post(s, '/api/jobs/create', b, job(2, 'b1'))).json()).job.id;
    const done = await waitFor(async () => {
      const all = [...(await get(s, '/api/jobs', a)).jobs, ...(await get(s, '/api/jobs', b)).jobs];
      return all.filter((j: any) => j.status === 'completed').length === 4 ? all : null;
    }, 120_000, 300);
    const order = done.sort((x: any, y: any) => Date.parse(x.completedAt) - Date.parse(y.completedAt)).map((j: any) => j.payload.title);
    assert.deepEqual(order, ['a1', 'b1', 'a2', 'a3'], `completion order ${order.join(' > ')}`);
  });
});

describe('B5: exactly-once render-minute settlement', () => {
  test('a completed job is charged exactly once; cancelled and failed jobs are not charged', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1' });
    const u = s.signFirebaseToken({ sub: 'b5-user' });
    const before = await minutesUsed(s, u);
    const j1 = (await (await post(s, '/api/jobs/create', u, job(6, 'billed'))).json()).job.id;
    const j2 = (await (await post(s, '/api/jobs/create', u, job(30, 'to-cancel'))).json()).job.id;
    assert.equal((await post(s, `/api/jobs/${j2}/cancel`, u)).status, 200);
    assert.equal((await post(s, `/api/jobs/${j2}/cancel`, u)).status, 409, 'a duplicate cancel is refused');
    await waitFor(async () => (await get(s, `/api/jobs/${j1}`, u)).job.status === 'completed');
    await new Promise((r) => setTimeout(r, 500));
    const after = await minutesUsed(s, u);
    assert.equal(Math.round((after - before) * 100) / 100, 0.1, `charged exactly 6 s = 0.1 min (before ${before}, after ${after})`);
  });

  test('PostgreSQL: if the charge cannot be written, the job is NOT marked completed (one transaction)', { skip: pgSkip }, async () => {
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.drop());
    const s = await boot({ DATABASE_URL: db.url, MAX_CONCURRENT_RENDERS: '1', JOB_STALE_MS: '600000' });
    const u = s.signFirebaseToken({ sub: 'b5-atomic' });
    // make any charge for this user fail at the database
    await db.pool.query(`CREATE FUNCTION forge_test_block_charge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id = 'firebase:b5-atomic' OR NEW.user_id = 'b5-atomic' THEN RAISE EXCEPTION 'injected charge failure'; END IF; RETURN NEW; END $$`);
    await db.pool.query('CREATE TRIGGER forge_test_block_charge BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION forge_test_block_charge()');
    const id = (await (await post(s, '/api/jobs/create', u, job(2, 'atomic'))).json()).job.id;
    await new Promise((r) => setTimeout(r, 6000)); // the render finishes; the completion+charge transaction fails
    const row = (await db.pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0];
    assert.notEqual(row.status, 'completed', 'a completed-but-unbilled render must be impossible');
    const charged = (await db.pool.query('SELECT monthly_render_minutes_used AS m FROM subscriptions WHERE user_id LIKE $1', ['%b5-atomic'])).rows[0];
    assert.ok(!charged || Number(charged.m) === 0);
  });

  test('JSON: a crash between recording the completion and the charge is charged exactly once on restart', async () => {
    const { JsonRepo } = await import('../server/lib/jsonRepo.ts');
    const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'b5-json-'));
    const limits = { maxProjectBytes: 1e6, guestMaxProjects: 10, guestMaxBytes: 1e7, userMaxProjects: 10, userMaxBytes: 1e7, guestPoolMaxBytes: 1e8, totalMaxBytes: 1e9, minFreeDiskBytes: 0 };
    const defaults = { plan: 'free' as const, status: 'active' as const, monthlyRenderMinutesUsed: 0, currentPeriodEnd: new Date(Date.now() + 864e5).toISOString() };
    const r1 = new JsonRepo(dir, path.join(dir, 'b'), limits, 50);
    r1.init();
    await r1.insertJob({ id: 'job_crash', userId: 'u1', type: 'render_video', status: 'queued', progress: 0, createdAt: new Date().toISOString(), payload: { duration: 30 } });
    const claimed = await r1.claimNextJob('w1');
    assert.equal(claimed?.id, 'job_crash');
    // crash right after the completion was recorded, before the charge
    const real = fs.renameSync;
    let writes = 0;
    (fs as any).renameSync = (a: string, b: string) => {
      if (String(b).endsWith('subscriptions.json') && ++writes === 1) throw new Error('simulated crash before the charge');
      return real(a, b);
    };
    try {
      await assert.rejects((r1 as any).completeJob({ ...claimed!, status: 'completed', progress: 100, completedAt: new Date().toISOString() }, 'w1', 30, defaults));
    } finally {
      (fs as any).renameSync = real;
    }
    for (let i = 0; i < 2; i++) {
      const r = new JsonRepo(dir, path.join(dir, 'b'), limits, 50);
      r.init(); // reconciliation runs here, twice in a row
      assert.equal((await r.getSubscription('u1'))?.monthlyRenderMinutesUsed, 0.5, `restart ${i + 1}: charged exactly once`);
    }
  });
});

describe('B6: timeouts', () => {
  test('a render exceeding its wall-clock limit is killed, failed as timed out, and not charged', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1', RENDER_TIMEOUT_MAX_S: '1', RENDER_TIMEOUT_MIN_S: '1' });
    const u = s.signFirebaseToken({ sub: 'b6-timeout' });
    const id = (await (await post(s, '/api/jobs/create', u, { type: 'render_video', payload: { title: 'slow', duration: 60, resolution: '1080p', beats: [{ text: 'slow', start_s: 0, end_s: 50 }] } })).json()).job.id;
    const j = await waitFor(async () => {
      const x = (await get(s, `/api/jobs/${id}`, u)).job;
      return x.status === 'failed' || x.status === 'completed' ? x : null;
    }, 30_000);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /timed out/i);
    assert.equal(await minutesUsed(s, u), 0);
    // the killed encoder is reaped: no ffmpeg child (running or <defunct>) remains
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await ffmpegChildren(s), []);
    assert.equal((await healthDetails(s.baseUrl)).renders.running, 0);
  });

  test('a job waiting in the queue longer than RENDER_QUEUE_TTL_S expires and is not charged', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1', RENDER_QUEUE_TTL_S: '2' });
    const a = s.signFirebaseToken({ sub: 'b6-busy' });
    const b = s.signFirebaseToken({ sub: 'b6-waiting' });
    await post(s, '/api/jobs/create', a, job(60, 'occupies the only slot'));
    await new Promise((r) => setTimeout(r, 500));
    const id = (await (await post(s, '/api/jobs/create', b, job(2, 'waits'))).json()).job.id;
    const j = await waitFor(async () => {
      const x = (await get(s, `/api/jobs/${id}`, b)).job;
      return x.status !== 'queued' ? x : null;
    }, 20_000);
    assert.equal(j.status, 'failed');
    assert.match(j.error, /expired|waited too long/i);
    assert.equal(await minutesUsed(s, b), 0);
  });
});

describe('B7: crash recovery', () => {
  for (const how of ['SIGKILL (crash)', 'SIGTERM (graceful shutdown, e.g. a deploy)'] as const) {
    test(`2 instances, the one rendering a job stops by ${how}: the job is completed by the other instance and charged once`, { skip: pgSkip }, async () => {
      const db = await createTestDatabase({ migrate: false });
      cleanups.push(() => db.drop());
      const env = { DATABASE_URL: db.url, MAX_CONCURRENT_RENDERS: '1', JOB_STALE_MS: '2000' };
      const A = await boot(env);
      const u = A.signFirebaseToken({ sub: `b7-${how.slice(0, 7).toLowerCase()}` });
      // B starts only after A has claimed the job
      const id = (await (await post(A, '/api/jobs/create', u, job(30, 'survives'))).json()).job.id;
      await waitFor(async () => (await db.pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0]?.status === 'processing');
      const B = await boot(env);
      if (how.startsWith('SIGKILL')) {
        const pid = Number(String((await healthDetails(A.baseUrl)).renders.instance).split(':')[1]);
        process.kill(pid, 'SIGKILL'); // no shutdown code runs; its ffmpeg is orphaned
      } else {
        await A.stopNow();
      }
      const final = await waitFor(async () => {
        const r = (await db.pool.query('SELECT status, error FROM jobs WHERE id = $1', [id])).rows[0];
        return r && (r.status === 'completed' || r.status === 'failed') ? r : null;
      }, 90_000, 500);
      assert.equal(final.status, 'completed', JSON.stringify(final));
      assert.equal(Number((await get(B, '/api/quota', u)).monthlyRenderMinutesUsed), 0.5, 'charged exactly once (30 s)');
    });
  }

  test('a job whose worker keeps dying is failed after RENDER_MAX_ATTEMPTS, never requeued forever', async () => {
    const { JsonRepo } = await import('../server/lib/jsonRepo.ts');
    const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'b7-json-'));
    const limits = { maxProjectBytes: 1e6, guestMaxProjects: 10, guestMaxBytes: 1e7, userMaxProjects: 10, userMaxBytes: 1e7, guestPoolMaxBytes: 1e8, totalMaxBytes: 1e9, minFreeDiskBytes: 0 };
    let r = new JsonRepo(dir, path.join(dir, 'b'), limits, 50);
    r.init();
    await r.insertJob({ id: 'job_doomed', userId: 'u1', type: 'render_video', status: 'queued', progress: 0, createdAt: new Date().toISOString(), payload: { duration: 5 } });
    const states: string[] = [];
    for (let crash = 0; crash < 3; crash++) {
      const c = await r.claimNextJob('w');
      states.push(c ? `claimed#${(c as any).attempts}` : 'none');
      r = new JsonRepo(dir, path.join(dir, 'b'), limits, 50); // the process "crashes"; a new one starts
      r.init();
      states.push((await r.getJob('job_doomed'))!.status);
    }
    assert.deepEqual(states, ['claimed#1', 'queued', 'claimed#2', 'failed', 'none', 'failed'], states.join(' '));
  });
});

describe('B9: the synchronous render route goes through the queue', () => {
  test('after RENDER_SYNC_WAIT_S it answers 202 + job id and the job still completes (charged once)', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1', RENDER_SYNC_WAIT_S: '1' });
    const u = s.signFirebaseToken({ sub: 'b9-sync' });
    // deterministic: another user's long job holds the only slot, so the sync job is still queued at the deadline
    const other = s.signFirebaseToken({ sub: 'b9-other' });
    const blocker = (await (await post(s, '/api/jobs/create', other, job(60, 'blocker'))).json()).job.id;
    await waitFor(async () => (await get(s, `/api/jobs/${blocker}`, other)).job.status === 'processing');
    const r = await post(s, '/api/render/video', u, job(6, 'sync').payload);
    assert.equal(r.status, 202, await r.clone().text());
    const { jobId } = await r.json();
    assert.match(jobId, /^job_/);
    assert.equal((await get(s, `/api/jobs/${jobId}`, u)).job.status, 'queued', 'answering 202 did not cancel the job');
    assert.equal((await post(s, `/api/jobs/${blocker}/cancel`, other)).status, 200);
    const done = await waitFor(async () => {
      const x = (await get(s, `/api/jobs/${jobId}`, u)).job;
      return x.status === 'queued' || x.status === 'processing' ? null : x;
    });
    assert.equal(done.status, 'completed', JSON.stringify(done));
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(Math.round((await minutesUsed(s, u)) * 100) / 100, 0.1);
  });

  test('a client that disconnects while waiting cancels its job; it is not charged', async () => {
    const s = await boot({ MAX_CONCURRENT_RENDERS: '1', RENDER_SYNC_WAIT_S: '120' });
    const u = s.signFirebaseToken({ sub: 'b9-leaves' });
    const ac = new AbortController();
    const pending = fetch(`${s.baseUrl}/api/render/video`, {
      method: 'POST',
      headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' },
      body: JSON.stringify(job(30, 'abandoned').payload),
      signal: ac.signal,
    }).catch(() => null);
    const j = await waitFor(async () => (await get(s, '/api/jobs', u)).jobs.find((x: any) => x.status === 'processing'), 20_000);
    ac.abort();
    await pending;
    const final = await waitFor(async () => {
      const x = (await get(s, `/api/jobs/${j.id}`, u)).job;
      return x.status === 'processing' ? null : x;
    }, 20_000);
    assert.equal(final.status, 'cancelled');
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(await minutesUsed(s, u), 0);
    assert.deepEqual(await ffmpegChildren(s), [], 'the encoder was stopped');
  });
});

describe('B8: no paid-priority claims', () => {
  test('no UI, API or docs text promises priority rendering or paid queue tiers', () => {
    const files = [path.join(ROOT, 'server.ts'), ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).map((f) => path.join(ROOT, 'src', String(f))).filter((f) => /\.(tsx?|json)$/.test(f))];
    const offenders: string[] = [];
    const re = /priority (render|queue|processing)|faster (render|queue)|skip the (render )?queue|render(s|ing)? first|queue priority/i;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
