// Repo contract: the SAME assertions run against JsonRepo and PostgresRepo (real PostgreSQL).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRepo } from '../server/lib/jsonRepo.ts';
import { PostgresRepo } from '../server/db/pgRepo.ts';
import { ProjectOwnershipError, type Repo } from '../server/lib/repo.ts';
import { StoreLimitError, type StoreLimits } from '../server/lib/projectStore.ts';
import { migrate } from '../server/db/migrate.ts';
import { createTestDatabase, pgSkip, PG_ADMIN_URL, type TestDb } from './helpers/pg.ts';
import { startTcpProxy } from './helpers/tcpProxy.ts';
import { checkout, withTx, createPool } from '../server/db/pool.ts';
import * as poolModule from '../server/db/pool.ts';

const KB = 1024;
const limits: StoreLimits = {
  maxProjectBytes: 64 * KB,
  guestMaxProjects: 3,
  guestMaxBytes: 100 * KB,
  userMaxProjects: 50,
  userMaxBytes: 400 * KB,
  guestPoolMaxBytes: 150 * KB,
  totalMaxBytes: 100_000 * KB,
  minFreeDiskBytes: 0,
};
const G1 = 'guest_' + '1'.repeat(32);
const G2 = 'guest_' + '2'.repeat(32);
const now = () => new Date().toISOString();
const proj = (id: string, userId: string, size = 10, extra: object = {}) => ({ id, userId, title: id, topic: 'x'.repeat(size), createdAt: now(), updatedAt: now(), ...extra });
const today = () => Math.floor(Date.now() / 86400000);

const dbs: TestDb[] = [];
after(async () => {
  for (const d of dbs) await d.drop();
});

async function makeRepo(kind: 'json' | 'postgres'): Promise<Repo> {
  if (kind === 'json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-json-'));
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 0);
    r.init();
    return r;
  }
  const db = await createTestDatabase();
  dbs.push(db);
  return new PostgresRepo(db.pool, limits);
}

for (const kind of ['json', 'postgres'] as const) {
  const skip = kind === 'postgres' ? pgSkip : false;
  describe(`Repo contract: ${kind}`, { skip }, () => {
    test('projects: isolation, ownership, list order, delete', async () => {
      const r = await makeRepo(kind);
      await r.saveProject('alice', proj('proj_a1', 'alice', 10, { updatedAt: '2026-01-01T00:00:00.000Z' }));
      await r.saveProject('alice', proj('proj_a2', 'alice', 10, { updatedAt: '2026-02-01T00:00:00.000Z' }));
      await r.saveProject('bob', proj('proj_b1', 'bob'));
      assert.deepEqual((await r.listProjects('alice')).map((p) => p.id), ['proj_a2', 'proj_a1']);
      assert.deepEqual((await r.listProjects('bob')).map((p) => p.id), ['proj_b1']);
      assert.equal((await r.getProject('proj_a1'))!.ownerId, 'alice');
      await assert.rejects(r.saveProject('bob', proj('proj_a1', 'bob')), (e: any) => e instanceof ProjectOwnershipError);
      assert.equal((await r.getProject('proj_a1'))!.project.userId, 'alice', 'not overwritten by another user');
      assert.equal(await r.deleteProject('bob', 'proj_a1'), false, 'cannot delete others');
      assert.equal(await r.deleteProject('alice', 'proj_a1'), true);
      assert.equal(await r.getProject('proj_a1'), null);
      // the stored document round-trips unchanged (API contract)
      const doc = proj('proj_rt', 'alice', 5, { script: { beats: [{ id: 'b', text: 'é 🎬', start_s: 0.5 }] }, clipStartSeconds: 15 });
      await r.saveProject('alice', doc);
      assert.deepEqual((await r.getProject('proj_rt'))!.project, doc);
    });

    test('quotas: guest count/bytes, guest pool, shrink allowed, too-large rejected', async () => {
      const r = await makeRepo(kind);
      for (let i = 1; i <= 3; i++) await r.saveProject(G1, proj(`proj_g${i}`, G1, 30 * KB));
      await assert.rejects(r.saveProject(G1, proj('proj_g4', G1)), (e: any) => e instanceof StoreLimitError && e.code === 'project_limit');
      await assert.rejects(r.saveProject(G1, proj('proj_g3', G1, 45 * KB)), (e: any) => e.code === 'storage_quota_exceeded');
      await r.saveProject(G1, proj('proj_g3', G1, 1 * KB));
      await assert.rejects(r.saveProject(G1, proj('proj_g2', G1, 70 * KB)), (e: any) => e.code === 'project_too_large');
      // pool: G1 holds ~61 KB; G2 may add until the 150 KB guest pool is full
      await r.saveProject(G2, proj('proj_h1', G2, 40 * KB));
      // G2: 40 + 50 KB stays under its own 100 KB cap, but the pool (≈61 + 40 + 50 KB) exceeds 150 KB
      await assert.rejects(r.saveProject(G2, proj('proj_h2', G2, 50 * KB)), (e: any) => e.status === 507 && e.code === 'guest_storage_full');
      await r.saveProject('signed-in', proj('proj_s1', 'signed-in', 60 * KB)); // signed-in users are not in the guest pool
      // deleting frees space again
      assert.equal(await r.deleteProject(G1, 'proj_g1'), true);
      await r.saveProject(G2, proj('proj_h2', G2, 20 * KB));
    });

    test('AI quota: all-or-nothing reservation, idempotent reserve/settle, refund, expiry', async () => {
      const r = await makeRepo(kind);
      const d = today();
      const e = [{ key: 'user:a', limit: 2 }, { key: 'ip:1', limit: 3 }];
      assert.equal((await r.reserveAi(e, d, 'res-0001')).ok, true);
      assert.equal((await r.reserveAi(e, d, 'res-0001')).ok, true, 'retried reserve with the same id');
      assert.equal(await r.peekAi('user:a', d), 1, '...never charges twice');
      assert.equal((await r.reserveAi(e, d, 'res-0002')).ok, true);
      assert.deepEqual(await r.reserveAi(e, d, 'res-0003'), { ok: false, key: 'user:a' });
      assert.equal(await r.peekAi('ip:1', d), 2, 'rejected reservation charged nothing');
      assert.equal(await r.settleAi('res-0002', 'refund'), 'settled');
      assert.equal(await r.settleAi('res-0002', 'refund'), 'already_settled', 'duplicate settle');
      assert.equal(await r.settleAi('res-0002', 'commit'), 'already_settled');
      assert.equal(await r.peekAi('user:a', d), 1, '...never double-refunds');
      assert.equal(await r.settleAi('res-0001', 'commit'), 'settled');
      assert.equal(await r.peekAi('user:a', d), 1, 'commit keeps the charge');
      assert.equal(await r.settleAi('res-unknown', 'refund'), 'already_settled', 'unknown id is a no-op');
      // a reservation that is never settled (crashed request) is refunded by expiry
      assert.equal((await r.reserveAi(e, d, 'res-0004')).ok, true);
      assert.equal(await r.peekAi('user:a', d), 2);
      await new Promise((res) => setTimeout(res, 60));
      assert.equal(await r.expireAiReservations(30), 1);
      assert.equal(await r.peekAi('user:a', d), 1, 'expired reservation refunded');
      assert.equal(await r.settleAi('res-0004', 'commit'), 'already_settled', 'late settle after expiry is a no-op');
      assert.equal(await r.expireAiReservations(30), 0, 'committed reservations never expire');
      assert.deepEqual(await r.reserveAi([{ key: 'user:z', limit: 0 }], d, 'res-0005'), { ok: false, key: 'user:z' });
    });

    test('rate buckets and windows', async () => {
      const r = await makeRepo(kind);
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) results.push((await r.takeRateTokens([{ key: 'g:user:u', max: 3 }, { key: 'g:ip:1', max: 12 }])).ok);
      assert.deepEqual(results, [true, true, true, false, false]);
      assert.equal((await r.takeRateTokens([{ key: 'g:user:other', max: 3 }, { key: 'g:ip:1', max: 12 }])).ok, true, 'other user on same IP unaffected');
      const w: boolean[] = [];
      for (let i = 0; i < 4; i++) w.push((await r.incrementWindow('mint', 42, 2)).ok);
      assert.deepEqual(w, [true, true, false, false]);
      assert.equal((await r.incrementWindow('mint', 43, 2)).ok, true, 'new window');
    });

    test('jobs: FIFO claim, heartbeat, cancel wins over finish, requeue, reap', async () => {
      const r = await makeRepo(kind);
      const mk = (id: string, t: string) => ({ id, userId: 'u', type: 'render_video', status: 'queued' as const, progress: 5, createdAt: t, payload: { duration: 2 } });
      await r.insertJob(mk('job_1', '2026-01-01T00:00:01.000Z'));
      await r.insertJob(mk('job_2', '2026-01-01T00:00:02.000Z'));
      // a per-user running cap of 10: FIFO within one user
      const c1 = await r.claimNextJob('w1', 10);
      assert.equal(c1!.id, 'job_1');
      assert.equal(c1!.attempts, 1, 'a claim counts an attempt');
      assert.equal((await r.claimNextJob('w2', 10))!.id, 'job_2');
      assert.equal(await r.claimNextJob('w3', 10), null);
      assert.equal(await r.heartbeat('job_1', 'w1', 50, 'half'), 'ok');
      assert.equal(await r.heartbeat('job_1', 'w2', 50, 'x'), 'lost', 'other worker cannot heartbeat');
      await r.cancelJob('job_1');
      assert.equal(await r.heartbeat('job_1', 'w1', 60, 'x'), 'cancelled');
      assert.equal(await r.finishJob({ ...c1!, status: 'completed', progress: 100 }, 'w1'), false, 'cancel wins');
      assert.equal((await r.getJob('job_1'))!.status, 'cancelled');
      assert.equal((await r.requeueJob('job_1')).job!.status, 'queued');
      // atomic admission: a denial inserts / requeues nothing
      const deny = () => [429, { error: 'cap' }] as [number, Record<string, unknown>];
      assert.deepEqual(await r.insertJob(mk('job_3', '2026-01-01T00:00:03.000Z'), deny), [429, { error: 'cap' }]);
      assert.equal(await r.getJob('job_3'), null);
      assert.equal((await r.activeJobs('u')).length, 2);
      await new Promise((res) => setTimeout(res, 50));
      assert.deepEqual(await r.reapStaleJobs(10, 1), { requeued: 0, failed: 1 }, 'job_2 worker stopped heart-beating; its 1 attempt is used up');
      assert.equal((await r.getJob('job_2'))!.status, 'failed');
      assert.deepEqual((await r.listJobs('u', 10)).map((j) => j.id).sort(), ['job_1', 'job_2']);
    });

    test('jobs (Track B): fair claim, per-user running cap, admission context, release, bounded reap, expiry', async () => {
      const r = await makeRepo(kind);
      const mk = (id: string, userId: string, t: string) => ({ id, userId, type: 'render_video', status: 'queued' as const, progress: 5, createdAt: t, payload: { duration: 2 } });
      await r.insertJob(mk('job_a1', 'ua', '2026-01-01T00:00:01.000Z'));
      await r.insertJob(mk('job_a2', 'ua', '2026-01-01T00:00:02.000Z'));
      await r.insertJob(mk('job_a3', 'ua', '2026-01-01T00:00:03.000Z'));
      // the admission rule sees the global queue length
      let seen = -1;
      await r.insertJob(mk('job_b1', 'ub', '2026-01-01T00:00:04.000Z'), (_active, ctx) => ((seen = ctx.globalQueued), null));
      assert.equal(seen, 3);
      const first = await r.claimNextJob('w1', 1);
      assert.equal(first!.id, 'job_a1');
      // ua already runs one job: ub goes next although ua's jobs are older
      assert.equal((await r.claimNextJob('w2', 1))!.id, 'job_b1');
      assert.equal(await r.claimNextJob('w3', 1), null, 'per-user running cap: nothing else may start');
      // graceful release: back to the queue, the attempt is not counted
      assert.equal(await r.releaseJob('job_a1', 'other-worker'), false, 'only the owner can release');
      assert.equal(await r.releaseJob('job_a1', 'w1'), true);
      const released = (await r.getJob('job_a1'))!;
      assert.equal(released.status, 'queued');
      assert.equal(released.attempts, 0);
      // ua was served less recently than ub (ub is running anyway): a1 again, FIFO within ua
      assert.equal((await r.claimNextJob('w1', 1))!.id, 'job_a1');
      // stale worker: requeued while attempts < max
      await new Promise((res) => setTimeout(res, 50));
      const reaped = await r.reapStaleJobs(10, 2);
      assert.equal(reaped.requeued, 2, JSON.stringify(reaped));
      assert.equal((await r.getJob('job_a1'))!.status, 'queued');
      // expiry: queued jobs older than the TTL fail (never charged)
      await new Promise((res) => setTimeout(res, 50));
      assert.equal(await r.expireQueuedJobs(10), 4);
      assert.match((await r.getJob('job_a3'))!.error!, /waited too long/);
      assert.equal(await r.claimNextJob('w1', 1), null);
    });

    test('jobs (Track B): 3 users x 3 jobs with one render slot are served round-robin', async () => {
      const r = await makeRepo(kind);
      const def = { plan: 'free' as const, status: 'active' as const, monthlyRenderMinutesUsed: 0, currentPeriodEnd: '2026-12-01T00:00:00.000Z' };
      let t = Date.parse('2026-01-01T00:00:00.000Z');
      for (const u of ['a', 'b', 'c']) {
        for (const n of [1, 2, 3]) await r.insertJob({ id: `job_rr_${u}${n}`, userId: `rr-${u}`, type: 'render_video', status: 'queued', progress: 5, createdAt: new Date((t += 1000)).toISOString() });
      }
      const order: string[] = [];
      for (let i = 0; i < 10; i++) {
        const j = await r.claimNextJob('w', 1);
        if (!j) break;
        order.push(j.id.slice(-2));
        await new Promise((res) => setTimeout(res, 5));
        assert.equal(await r.completeJob({ ...j, status: 'completed', progress: 100, completedAt: new Date().toISOString() }, 'w', 2, def), true);
      }
      assert.deepEqual(order, ['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3']);
    });

    test('jobs (Track B, F7): completeJob completes and charges exactly once; a cancelled job is neither', async () => {
      const r = await makeRepo(kind);
      const def = { plan: 'free' as const, status: 'active' as const, monthlyRenderMinutesUsed: 0, currentPeriodEnd: '2026-12-01T00:00:00.000Z' };
      const mk = (id: string, t: string) => ({ id, userId: 'uc', type: 'render_video', status: 'queued' as const, progress: 5, createdAt: t, payload: { duration: 30 } });
      await r.insertJob(mk('job_c1', '2026-01-01T00:00:01.000Z'));
      await r.insertJob(mk('job_c2', '2026-01-01T00:00:02.000Z'));
      const c1 = (await r.claimNextJob('w1', 5))!;
      const c2 = (await r.claimNextJob('w2', 5))!;
      const done = (j: typeof c1) => ({ ...j, status: 'completed' as const, progress: 100, completedAt: new Date().toISOString(), result: { ok: true } });
      assert.equal(await r.completeJob(done(c1), 'w1', 30, def), true);
      assert.equal(await r.completeJob(done(c1), 'w1', 30, def), false, 'a second completion is refused and not charged');
      await r.cancelJob(c2.id);
      assert.equal(await r.completeJob(done(c2), 'w2', 30, def), false, 'cancel wins: not completed, not charged');
      assert.equal((await r.getJob('job_c1'))!.status, 'completed');
      assert.equal((await r.getJob('job_c2'))!.status, 'cancelled');
      assert.equal((await r.getSubscription('uc'))!.monthlyRenderMinutesUsed, 0.5);
    });

    test('subscriptions: absent by default, put/get, render minutes accumulate', async () => {
      const r = await makeRepo(kind);
      assert.equal(await r.getSubscription('u'), null);
      const def = { plan: 'free' as const, status: 'active' as const, monthlyRenderMinutesUsed: 0, currentPeriodEnd: '2026-12-01T00:00:00.000Z' };
      await r.addRenderMinutes('u', 30, def);
      await r.addRenderMinutes('u', 90, def);
      assert.equal((await r.getSubscription('u'))!.monthlyRenderMinutesUsed, 2);
      await r.putSubscription('u', { ...def, plan: 'pro', demo: true });
      const s = (await r.getSubscription('u'))!;
      assert.equal(s.plan, 'pro');
      assert.equal(s.demo, true);
    });
  });
}

describe('PostgreSQL specifics', { skip: pgSkip }, () => {
  test('migrations are idempotent, checksummed and safe to run concurrently', async () => {
    const db = await createTestDatabase({ migrate: false });
    dbs.push(db);
    const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
    assert.equal(results.filter((r) => r.applied.length > 0).length, 1, 'exactly one runner applied the schema');
    assert.deepEqual((await migrate(db.pool)).applied, []);
    await db.pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    await assert.rejects(migrate(db.pool), /modified after it was applied/);
  });

  test('concurrent writes: quota is exact and counters stay consistent under parallel saves', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, { ...limits, guestMaxProjects: 5 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => r.saveProject(G1, proj(`proj_c${i}`, G1, 1 * KB))));
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 5);
    assert.ok(results.filter((x) => x.status === 'rejected').every((x: any) => x.reason.code === 'project_limit'));
    const { rows } = await db.pool.query(
      `SELECT u.project_count, u.storage_bytes, (SELECT count(*)::int FROM projects WHERE user_id = u.id) AS real_count,
              (SELECT coalesce(sum(size_bytes),0)::bigint FROM projects WHERE user_id = u.id) AS real_bytes,
              (SELECT bytes FROM storage_totals WHERE scope = 'guest') AS guest_total
       FROM users u WHERE id = $1`,
      [G1],
    );
    assert.equal(rows[0].project_count, 5);
    assert.equal(rows[0].real_count, 5);
    assert.equal(String(rows[0].storage_bytes), String(rows[0].real_bytes));
    assert.equal(String(rows[0].guest_total), String(rows[0].real_bytes));
    // concurrent updates of ONE project: serialized, last writer wins, no duplicate rows, counters unchanged
    await Promise.all(Array.from({ length: 10 }, (_, i) => r.saveProject(G1, proj('proj_c0', G1, 2 * KB, { title: `v${i}` }))));
    const one = await db.pool.query("SELECT count(*)::int AS n FROM projects WHERE id = 'proj_c0'");
    assert.equal(one.rows[0].n, 1);
    const after = (await db.pool.query('SELECT project_count FROM users WHERE id = $1', [G1])).rows[0];
    assert.equal(after.project_count, 5);
  });

  test('concurrent AI reservations cannot exceed the limit', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    const d = today();
    const out = await Promise.all(Array.from({ length: 25 }, (_, i) => r.reserveAi([{ key: 'user:x', limit: 7 }, { key: 'ip:y', limit: 100 }], d, `conc-${i}-xxxx`)));
    assert.equal(out.filter((o) => o.ok).length, 7);
    assert.equal(await r.peekAi('user:x', d), 7);
    assert.equal(await r.peekAi('ip:y', d), 7, 'ip charged only for successful reservations');
  });

  test('jobs: concurrent claims never hand the same job to two workers', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    for (let i = 0; i < 10; i++) await r.insertJob({ id: `job_${i}`, userId: 'u', type: 'render_video', status: 'queued', progress: 5, createdAt: new Date(Date.now() + i).toISOString() });
    const claims = await Promise.all(Array.from({ length: 15 }, (_, i) => r.claimNextJob(`w${i}`, 100)));
    const ids = claims.filter(Boolean).map((j) => j!.id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
  });

  test('jobs (Track B): concurrent claims never exceed the per-user running cap', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    // 4 users x 5 jobs, 20 concurrent claimers, cap 1 per user: exactly one running job per user
    for (let u = 0; u < 4; u++) {
      for (let i = 0; i < 5; i++) await r.insertJob({ id: `job_${u}_${i}`, userId: `cap-u${u}`, type: 'render_video', status: 'queued', progress: 5, createdAt: new Date(Date.now() + i).toISOString() });
    }
    const claims = (await Promise.all(Array.from({ length: 20 }, (_, i) => r.claimNextJob(`w${i}`, 1)))).filter(Boolean);
    assert.equal(claims.length, 4, `${claims.length} claims`);
    const { rows } = await db.pool.query("SELECT user_id, count(*)::int AS n FROM jobs WHERE status = 'processing' GROUP BY user_id");
    assert.ok(rows.every((x: any) => x.n === 1), JSON.stringify(rows));
    assert.equal(await r.claimNextJob('more', 1), null, 'every user is at the cap');
  });

  test('jobs (Track B): the global queue cap is exact under concurrent admissions', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    const cap = (_a: unknown, ctx: { globalQueued: number }) => (ctx.globalQueued >= 7 ? ([429, { code: 'queue_full' }] as [number, Record<string, unknown>]) : null);
    const out = await Promise.all(Array.from({ length: 30 }, (_, i) => r.insertJob({ id: `job_g${i}`, userId: `g-u${i}`, type: 'render_video', status: 'queued', progress: 5, createdAt: new Date().toISOString() }, cap)));
    assert.equal(out.filter((x) => x === null).length, 7);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'queued'")).rows[0].n, 7);
  });

  test('a connection lost while a client is checked out is an error, never an uncaught exception (CI regression)', async () => {
    const admin = new URL(PG_ADMIN_URL);
    const proxy = await startTcpProxy(admin.hostname, Number(admin.port || 5432));
    const u = new URL(PG_ADMIN_URL);
    u.hostname = '127.0.0.1';
    u.port = String(proxy.port);
    const pool = createPool(u.toString(), { max: 2 });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      // 1. idle-but-checked-out client (between statements of a transaction)
      const held = await checkout(pool);
      await held.client.query('BEGIN');
      await proxy.down();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(held.broken(), 'loss recorded on the client');
      held.release(); // destroyed, not returned to the pool
      // 2. a transaction running while the connection dies rejects cleanly
      await proxy.up();
      await assert.rejects(
        withTx(pool, async (tx) => {
          await tx.query('SELECT 1');
          await proxy.down();
          await tx.query('SELECT pg_sleep(0.2)');
        }),
      );
      await proxy.up();
      assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'pool recovers with fresh connections');
      assert.deepEqual(uncaught, []);
    } finally {
      process.off('uncaughtException', onUncaught);
      await pool.end().catch(() => {});
      await proxy.close();
    }
  });

  test('R-02 regression: 200 concurrent reserve->refund cycles sharing one IP key never deadlock and net to zero', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    const d = today();
    const errors: string[] = [];
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const id = `storm-${i}-${Math.random().toString(36).slice(2, 10)}`;
        try {
          // entries deliberately passed in user->ip order (the order that used to deadlock against the refund)
          const out = await r.reserveAi([{ key: `user:u${i % 20}`, limit: 1000 }, { key: 'ip:shared', limit: 100000 }], d, id);
          if (out.ok) await r.settleAi(id, i % 3 === 0 ? 'commit' : 'refund');
        } catch (err: any) {
          errors.push(`${err?.code || ''} ${err?.message || err}`);
        }
      }),
    );
    assert.deepEqual(errors, [], 'no deadlock / serialization errors surfaced');
    const committed = Array.from({ length: 200 }, (_, i) => i).filter((i) => i % 3 === 0).length;
    assert.equal(await r.peekAi('ip:shared', d), committed, 'IP counter == committed reservations exactly');
    const { rows } = await db.pool.query("SELECT status, count(*)::int AS n FROM ai_reservations GROUP BY status ORDER BY status");
    assert.deepEqual(rows, [{ status: 'committed', n: committed }, { status: 'refunded', n: 200 - committed }]);
  });

  test('withTx retries a deadlocked transaction safely (rolled back first, applied exactly once)', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    await db.pool.query('CREATE TABLE t (id int PRIMARY KEY, v int)');
    await db.pool.query('INSERT INTO t VALUES (1, 0), (2, 0)');
    // Two transactions lock rows 1 and 2 in opposite order: PostgreSQL aborts one with 40P01; withTx retries it.
    const barrier = (() => {
      let n = 0;
      let release!: () => void;
      const p = new Promise<void>((res) => (release = res));
      return () => {
        n++;
        if (n === 2) release();
        return p;
      };
    })();
    let firstAttempts = 0;
    const run = (a: number, b: number) =>
      withTx(db.pool, async (tx) => {
        if (a === 1) firstAttempts++;
        await tx.query('UPDATE t SET v = v + 1 WHERE id = $1', [a]);
        if (firstAttempts <= 1 || a !== 1) await Promise.race([barrier(), new Promise((r) => setTimeout(r, 300))]);
        await tx.query('UPDATE t SET v = v + 1 WHERE id = $1', [b]);
      });
    const retriesBefore = poolModule.txRetryCount;
    await Promise.all([run(1, 2), run(2, 1)]);
    assert.ok(poolModule.txRetryCount > retriesBefore, 'a real deadlock occurred and was retried (not a vacuous pass)');
    const { rows } = await db.pool.query('SELECT id, v FROM t ORDER BY id');
    assert.deepEqual(rows, [{ id: 1, v: 2 }, { id: 2, v: 2 }], 'both transactions applied exactly once each');
  });
});
