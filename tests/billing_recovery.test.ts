// Track B verification (owner review of PR #5): exactly-once render billing and crash recovery at the
// completion/charge boundary, with failure injection. These tests were added AFTER the implementation, as
// verification evidence requested in review; they are not red-first tests.
//
//  JSON backend (single instance, two durable writes made exactly-once by reconciliation):
//    J1 crash while writing the completion          -> not completed, not charged; restart requeues; charged once later
//    J2 crash between completion and charge          -> (tests/render_queue.test.ts B5) charged once on restart
//    J3 crash while the restart reconciles the charge -> next restart charges it, exactly once
//    J4 many restarts after a normal completion      -> still charged once
//    J5 a monthly reset after the charge             -> reconciliation does NOT charge the old job again
//  PostgreSQL (2 instances, real ffmpeg):
//    P1 the instance dies INSIDE the completion+charge transaction -> rolled back as a unit; the job is recovered,
//       rendered again by the other instance and charged exactly once
//  Source check:
//    S1 the only code that starts a render encoder is the queue worker (no endpoint bypasses the queue)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRepo } from '../server/lib/jsonRepo.ts';
import type { ServerJob, StoredSubscription } from '../server/lib/repo.ts';
import { startTestServer, healthDetails, type TestServer } from './helpers/server.ts';
import { createTestDatabase, pgSkip } from './helpers/pg.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});

// ---------------- JSON backend ----------------
const LIMITS = { maxProjectBytes: 1e6, guestMaxProjects: 10, guestMaxBytes: 1e7, userMaxProjects: 10, userMaxBytes: 1e7, guestPoolMaxBytes: 1e8, totalMaxBytes: 1e9, minFreeDiskBytes: 0 };
const DEFAULTS: StoredSubscription = { plan: 'free', status: 'active', monthlyRenderMinutesUsed: 0, currentPeriodEnd: new Date(Date.now() + 864e5).toISOString() };

function jsonDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'billing-json-'));
}
/** A new process: a fresh JsonRepo over the same files, whose init() runs recovery and reconciliation. */
function restart(dir: string) {
  const r = new JsonRepo(dir, path.join(dir, 'b'), LIMITS, 50);
  r.init();
  return r;
}
/** Makes the n-th atomic rename onto `file` throw (simulated crash/IO failure at exactly that write). */
function failRename(file: string, nth = 1) {
  const real = fs.renameSync;
  let n = 0;
  (fs as any).renameSync = (a: string, b: string) => {
    if (String(b).endsWith(file) && ++n === nth) throw new Error(`injected failure writing ${file}`);
    return real(a, b);
  };
  return () => ((fs as any).renameSync = real);
}
const done = (j: ServerJob): ServerJob => ({ ...j, status: 'completed', progress: 100, completedAt: new Date().toISOString(), result: { ok: true } });
async function claimed(r: JsonRepo, id: string, seconds = 30) {
  await r.insertJob({ id, userId: 'u1', type: 'render_video', status: 'queued', progress: 0, createdAt: new Date().toISOString(), payload: { duration: seconds } });
  const c = await r.claimNextJob('w1');
  assert.equal(c?.id, id);
  return c!;
}
const used = async (r: JsonRepo) => (await r.getSubscription('u1'))?.monthlyRenderMinutesUsed ?? 0;

describe('JSON backend: exactly-once charge across crashes at the completion boundary', () => {
  test('J1: a crash while writing the completion leaves the job uncompleted and uncharged; it is recovered and charged once', async () => {
    const dir = jsonDir();
    const r1 = restart(dir);
    const c = await claimed(r1, 'job_j1');
    const restore = failRename('jobs.json');
    try {
      await assert.rejects(r1.completeJob(done(c), 'w1', 30, DEFAULTS), /injected failure writing jobs.json/);
    } finally {
      restore();
    }
    assert.equal((await r1.getJob('job_j1'))!.status, 'processing', 'the completion was not written');
    assert.equal(await used(r1), 0, 'nothing charged');
    const r2 = restart(dir); // the process died; recovery requeues (attempt 1 < 2)
    assert.equal((await r2.getJob('job_j1'))!.status, 'queued');
    assert.equal(await used(r2), 0);
    const again = (await r2.claimNextJob('w2'))!;
    assert.equal(again.attempts, 2);
    assert.equal(await r2.completeJob(done(again), 'w2', 30, DEFAULTS), true);
    assert.equal(await used(r2), 0.5);
    for (let i = 0; i < 3; i++) assert.equal(await used(restart(dir)), 0.5, `restart ${i + 1}: still charged once`);
  });

  test('J3: a crash while the restart reconciles the charge is repaired by the next restart, exactly once', async () => {
    const dir = jsonDir();
    const r1 = restart(dir);
    const c = await claimed(r1, 'job_j3');
    let restore = failRename('subscriptions.json'); // crash 1: between completion and charge
    try {
      await assert.rejects(r1.completeJob(done(c), 'w1', 30, DEFAULTS));
    } finally {
      restore();
    }
    restore = failRename('subscriptions.json'); // crash 2: the reconciliation's own write fails
    let r2: JsonRepo;
    try {
      r2 = restart(dir); // must not throw: the failure is logged, the job keeps its durable billedSeconds
    } finally {
      restore();
    }
    assert.equal(await used(r2), 0, 'the reconciliation write failed, so nothing is charged yet');
    assert.equal((await r2.getJob('job_j3'))!.billedSeconds, 30, 'the charge intent is still on disk');
    for (let i = 0; i < 3; i++) assert.equal(await used(restart(dir)), 0.5, `restart ${i + 1}: charged exactly once`);
  });

  test('J4: after a normal completion, repeated restarts never charge again', async () => {
    const dir = jsonDir();
    const r1 = restart(dir);
    const c = await claimed(r1, 'job_j4');
    assert.equal(await r1.completeJob(done(c), 'w1', 30, DEFAULTS), true);
    assert.equal(await r1.completeJob(done(c), 'w1', 30, DEFAULTS), false, 'a duplicate completion is refused');
    for (let i = 0; i < 5; i++) assert.equal(await used(restart(dir)), 0.5);
  });

  test('J5: a monthly reset after the charge does not make reconciliation charge the old job again', async () => {
    const dir = jsonDir();
    const r1 = restart(dir);
    const c = await claimed(r1, 'job_j5');
    assert.equal(await r1.completeJob(done(c), 'w1', 30, DEFAULTS), true);
    // what getUserSubscription does at a period rollover
    await r1.putSubscription('u1', { ...(await r1.getSubscription('u1'))!, monthlyRenderMinutesUsed: 0 });
    assert.equal(await used(restart(dir)), 0, 'the charge record survived the reset; nothing re-charged');
    assert.equal(await used(restart(dir)), 0);
  });

  test('J6: failed, cancelled, expired and stale-reassigned jobs are never charged', async () => {
    const dir = jsonDir();
    const r = restart(dir);
    const f = await claimed(r, 'job_failed');
    assert.equal(await r.finishJob({ ...f, status: 'failed', error: 'x', completedAt: new Date().toISOString() }, 'w1'), true);
    const k = await claimed(r, 'job_cancel');
    await r.cancelJob(k.id);
    assert.equal(await r.completeJob(done(k), 'w1', 30, DEFAULTS), false, 'a render that finishes after its cancel is not charged');
    await r.insertJob({ id: 'job_expire', userId: 'u1', type: 'render_video', status: 'queued', progress: 0, createdAt: new Date().toISOString(), payload: { duration: 30 } });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(await r.expireQueuedJobs(10), 1);
    for (let i = 0; i < 2; i++) assert.equal(await used(restart(dir)), 0, 'no charge for any of them, across restarts');
  });
});

// ---------------- PostgreSQL, two instances ----------------
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
async function boot(env: Record<string, string>) {
  const s = await startTestServer({ BACKUP_INTERVAL_HOURS: '0', SESSION_SECRET, JOB_HEARTBEAT_MS: '200', ...env });
  cleanups.push(() => s.stop());
  return s;
}
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 200): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
}

describe('PostgreSQL: an instance that dies inside the completion+charge transaction', () => {
  test('P1: the transaction rolls back as a unit; the other instance recovers the job and it is charged exactly once', { skip: pgSkip }, async () => {
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.drop());
    // The FIRST charge for this user blocks inside the transaction (after the job row was already updated to
    // 'completed' by the same transaction). A sequence is used because nextval() is not rolled back.
    await db.pool.query('CREATE SEQUENCE forge_test_charge_calls');
    await db.pool.query(`CREATE FUNCTION forge_test_hold_first_charge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id LIKE '%p1-boundary' AND nextval('forge_test_charge_calls') = 1 THEN PERFORM pg_sleep(60); END IF;
      RETURN NEW; END $$`);
    await db.pool.query('CREATE TRIGGER forge_test_hold_first_charge BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION forge_test_hold_first_charge()');

    const env = { DATABASE_URL: db.url, MAX_CONCURRENT_RENDERS: '1', JOB_STALE_MS: '2000' };
    const A = await boot(env);
    const u = A.signFirebaseToken({ sub: 'p1-boundary' });
    const created = await fetch(`${A.baseUrl}/api/jobs/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'render_video', payload: { title: 'boundary', duration: 6, resolution: '720p', beats: [{ text: 'b', start_s: 0, end_s: 1 }] } }),
    });
    assert.equal(created.status, 200);
    const id = (await created.json()).job.id;
    // A renders, then blocks inside completeJob's transaction: the job UPDATE is done, the charge is not committed
    const holder = await waitFor(async () => (await db.pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND datname = current_database()")).rows[0], 60_000);
    // other sessions still see the committed state: processing, nothing charged
    assert.equal((await db.pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0].status, 'processing');
    const B = await boot(env);
    // the instance dies mid-transaction; PostgreSQL ends its session (here explicitly, as connection loss detection would)
    const pid = Number(String((await healthDetails(A.baseUrl)).renders.instance).split(':')[1]);
    process.kill(pid, 'SIGKILL');
    await db.pool.query('SELECT pg_terminate_backend($1)', [holder.pid]);
    // rolled back as a unit: neither the completion nor the charge survived
    const mid = (await db.pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0];
    assert.notEqual(mid.status, 'completed', 'a completed-but-unbilled job must be impossible');
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM subscriptions WHERE user_id LIKE '%p1-boundary'")).rows[0].n, 0);
    // B's reaper requeues the stale job, B renders it and charges it
    const final = await waitFor(async () => {
      const r = (await db.pool.query('SELECT status, attempts, error FROM jobs WHERE id = $1', [id])).rows[0];
      return r.status === 'completed' || r.status === 'failed' ? r : null;
    }, 90_000, 300);
    assert.equal(final.status, 'completed', JSON.stringify(final));
    assert.equal(final.attempts, 2, 'claimed by A, then recovered and claimed by B');
    const charged = (await db.pool.query("SELECT monthly_render_minutes_used AS m FROM subscriptions WHERE user_id LIKE '%p1-boundary'")).rows;
    assert.equal(charged.length, 1);
    assert.equal(Number(charged[0].m), 0.1, 'charged exactly once (6 s)');
    const quota = await (await fetch(`${B.baseUrl}/api/quota`, { headers: { authorization: `Bearer ${u}` } })).json();
    assert.equal(Number(quota.monthlyRenderMinutesUsed), 0.1);
  });
});

// ---------------- no render path bypasses the queue ----------------
describe('S1: the queue worker is the only code that starts a render encoder', () => {
  test('renderVideoWithFfmpeg is called only from executeRenderJob; ffmpeg is spawned only there and by the -version probe', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
    const callSites = [...src.matchAll(/renderVideoWithFfmpeg\(/g)].map((m) => m.index!);
    // one definition + one call
    assert.equal(callSites.length, 2, `renderVideoWithFfmpeg( appears ${callSites.length} times`);
    const def = src.indexOf('function renderVideoWithFfmpeg(');
    const exec = src.indexOf('async function executeRenderJob(');
    const execEnd = src.indexOf('\n}\n', exec);
    const call = callSites.find((i) => i !== def + 'function '.length)!;
    assert.ok(call > exec && call < execEnd, 'the only call is inside executeRenderJob (the queue worker)');
    const spawns = [...src.matchAll(/spawn\('ffmpeg', ([^,]+)/g)].map((m) => m[1]);
    assert.deepEqual(spawns, ["['-version']", 'args'], 'ffmpeg spawned only by the readiness probe and the render function');
    // Verify mediaOrchestrator.executeQueuedRenderJob is also invoked exclusively inside executeRenderJob
    const mediaCallSites = [...src.matchAll(/executeQueuedRenderJob\(/g)].map((m) => m.index!);
    assert.ok(mediaCallSites.length <= 1, `executeQueuedRenderJob( appears ${mediaCallSites.length} times in server.ts`);
    for (const c of mediaCallSites) {
      assert.ok(c > exec && c < execEnd, 'executeQueuedRenderJob is only called inside executeRenderJob (the queue worker)');
    }
    // Outside server/media_engine/*, nothing else in the server tree spawns ffmpeg directly
    const others = fs
      .readdirSync(path.join(ROOT, 'server'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.startsWith(`media_engine${path.sep}`));
    for (const f of others) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'server', f), 'utf8'), /spawn\(\s*['"]ffmpeg['"]/, f);
  });
});
