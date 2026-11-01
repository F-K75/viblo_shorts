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
import { createTestDatabase, pgSkip, type TestDb } from './helpers/pg.ts';

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

    test('AI quota: all-or-nothing reservation, refund, peek', async () => {
      const r = await makeRepo(kind);
      const d = today();
      const e = [{ key: 'user:a', limit: 2 }, { key: 'ip:1', limit: 3 }];
      assert.equal((await r.reserveAi(e, d)).ok, true);
      assert.equal((await r.reserveAi(e, d)).ok, true);
      assert.deepEqual(await r.reserveAi(e, d), { ok: false, key: 'user:a' });
      assert.equal(await r.peekAi('ip:1', d), 2, 'rejected reservation charged nothing');
      await r.refundAi(['user:a', 'ip:1'], d);
      assert.equal(await r.peekAi('user:a', d), 1);
      assert.deepEqual(await r.reserveAi([{ key: 'user:z', limit: 0 }], d), { ok: false, key: 'user:z' });
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
      const c1 = await r.claimNextJob('w1');
      assert.equal(c1!.id, 'job_1');
      assert.equal((await r.claimNextJob('w2'))!.id, 'job_2');
      assert.equal(await r.claimNextJob('w3'), null);
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
      assert.equal(await r.reapStaleJobs(10), 1, 'job_2 worker stopped heart-beating');
      assert.equal((await r.getJob('job_2'))!.status, 'failed');
      assert.deepEqual((await r.listJobs('u', 10)).map((j) => j.id).sort(), ['job_1', 'job_2']);
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
    const out = await Promise.all(Array.from({ length: 25 }, () => r.reserveAi([{ key: 'user:x', limit: 7 }, { key: 'ip:y', limit: 100 }], d)));
    assert.equal(out.filter((o) => o.ok).length, 7);
    assert.equal(await r.peekAi('user:x', d), 7);
    assert.equal(await r.peekAi('ip:y', d), 7, 'ip charged only for successful reservations');
  });

  test('jobs: concurrent claims never hand the same job to two workers', async () => {
    const db = await createTestDatabase();
    dbs.push(db);
    const r = new PostgresRepo(db.pool, limits);
    for (let i = 0; i < 10; i++) await r.insertJob({ id: `job_${i}`, userId: 'u', type: 'render_video', status: 'queued', progress: 5, createdAt: new Date(Date.now() + i).toISOString() });
    const claims = await Promise.all(Array.from({ length: 15 }, (_, i) => r.claimNextJob(`w${i}`)));
    const ids = claims.filter(Boolean).map((j) => j!.id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
  });
});
