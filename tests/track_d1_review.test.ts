// Track D-1, second review (owner requests of 2026-11-09): evidence tests for the review pass.
//  R1  the provider is never called before the attempt is durable; a failed durable write means no provider call
//  R2  concurrent attempts on ONE reservation: exactly one settlement, never more than the reserved unit
//  R6  migration 0006 upgrade from a real version-5 database: legacy rows, interrupted migration, previous release
// Verification tests of the review-pass implementation (not red-first; see each test).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { JsonRepo } from '../server/lib/jsonRepo.ts';
import { PostgresRepo } from '../server/db/pgRepo.ts';
import type { Repo } from '../server/lib/repo.ts';
import type { StoreLimits } from '../server/lib/projectStore.ts';
import { createTestDatabase, pgSkip, type TestDb } from './helpers/pg.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS = path.join(ROOT, 'server', 'db', 'migrations');
const limits: StoreLimits = {
  maxProjectBytes: 64 * 1024,
  guestMaxProjects: 3,
  guestMaxBytes: 100 * 1024,
  userMaxProjects: 50,
  userMaxBytes: 400 * 1024,
  guestPoolMaxBytes: 150 * 1024,
  totalMaxBytes: 100_000 * 1024,
  minFreeDiskBytes: 0,
};
const aiDay = () => Math.floor(Date.now() / 86400000);
const dbs: TestDb[] = [];
after(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
});
async function makeRepo(kind: 'json' | 'postgres'): Promise<{ r: Repo; db?: TestDb }> {
  if (kind === 'json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1r-json-'));
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 1000);
    r.init();
    return { r };
  }
  const db = await createTestDatabase();
  dbs.push(db);
  return { r: new PostgresRepo(db.pool, limits), db };
}

// ---------------------------------------------------------------- R1: durability before the provider call
describe('Review R1 evidence (server): the attempt is durable when the provider receives the request', () => {
  test('at the instant the provider receives the call, the attempt is already on disk (JSON) / committed (PostgreSQL)', async () => {
    const { startTestServer, TEST_BACKEND } = await import('./helpers/server.ts');
    const { startGeminiStub } = await import('./helpers/geminiStub.ts');
    const stub = await startGeminiStub();
    const s = await startTestServer({ GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', LLM_TIMEOUT_MS: '4000' });
    const pgc = s.databaseUrl ? new pg.Client({ connectionString: s.databaseUrl }) : null;
    try {
      if (pgc) await pgc.connect();
      const seen: Array<{ open: number; total: number }> = [];
      stub.onRequest = async () => {
        if (pgc) {
          // another connection: sees only COMMITTED state
          const row = (await pgc.query("SELECT attempts_open, attempts_total FROM ai_reservations WHERE status = 'reserved' ORDER BY created_at DESC LIMIT 1")).rows[0];
          seen.push({ open: row?.attempts_open ?? -1, total: row?.attempts_total ?? -1 });
        } else {
          // the file on disk, as a restarted process would read it
          const file = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'usage.json'), 'utf8'));
          const open = Object.values<any>(file.reservations || {});
          seen.push({ open: open[0]?.attempts?.open ?? -1, total: open[0]?.attempts?.total ?? -1 });
        }
      };
      const u = s.signFirebaseToken({ sub: 'r1-evidence' });
      stub.queue = ['fail', 'ok']; // two attempts: each must be durable before its provider call
      const r = await fetch(`${s.baseUrl}/api/generate-script`, { method: 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'sleep habits' }) });
      assert.equal(r.status, 200);
      assert.deepEqual(seen, [{ open: 1, total: 1 }, { open: 1, total: 2 }], `backend ${TEST_BACKEND}: durable state seen by the provider at each call`);
    } finally {
      await pgc?.end().catch(() => {});
      await s.stop();
      await stub.close();
    }
  });

  test('JSON: if the attempt cannot be written to disk, the provider is NOT called and the reservation is refunded', async () => {
    const { startTestServer } = await import('./helpers/server.ts');
    const { startGeminiStub } = await import('./helpers/geminiStub.ts');
    const stub = await startGeminiStub();
    const s = await startTestServer({ STORAGE_BACKEND: 'json', DATABASE_URL: '', GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model' });
    try {
      const u = s.signFirebaseToken({ sub: 'r1-diskfail' });
      const quota = async () => (await (await fetch(`${s.baseUrl}/api/quota`, { headers: { authorization: `Bearer ${u}` } })).json()).dailyQuotaUsed;
      const used0 = await quota();
      // make every later ledger write fail: usage.json becomes a directory (rename onto a directory fails, also as root)
      const file = path.join(s.dataDir, 'usage.json');
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file);
      const before = stub.calls;
      const r = await fetch(`${s.baseUrl}/api/generate-script`, { method: 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'sleep habits' }) });
      assert.equal(r.status, 200, 'the user gets the template fallback');
      assert.equal((await r.json()).isFallback, true);
      assert.equal(stub.calls, before, 'no provider call without a durable attempt record');
      await new Promise((res) => setTimeout(res, 200));
      assert.equal(await quota(), used0, 'no attempt was made: refunded');
      assert.match(s.logs(), /usage_attempt_not_persisted/);
    } finally {
      await s.stop();
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------- R2: concurrency on one reservation
for (const kind of ['json', 'postgres'] as const) {
  describe(`Review R2 evidence (${kind}): concurrent attempts and settlements on one reservation`, { skip: kind === 'postgres' ? pgSkip : false }, () => {
    test('20 rounds: 8 attempts in parallel, their outcomes racing 3 settlements: one settlement, at most one unit, billable => charged', async () => {
      const { r, db } = await makeRepo(kind);
      const ai = r as any;
      const day = aiDay();
      const key = `user:r2c-${kind}`;
      let charged = 0;
      for (let round = 0; round < 20; round++) {
        const id = `r2c-${kind}-${String(round).padStart(4, '0')}`;
        assert.deepEqual(await r.reserveAi([{ key, limit: 1000 }], day, id), { ok: true });
        const begun = await Promise.all(Array.from({ length: 8 }, () => ai.beginAiAttempt(id)));
        assert.deepEqual(begun, Array(8).fill(true), `round ${round}: all attempts begin while open`);
        // round % 3: 0 = all provider errors, 1 = one billable, 2 = one uncertain
        const outcomes = Array.from({ length: 8 }, (_, i) => (i === 3 && round % 3 === 1 ? 'yes' : i === 5 && round % 3 === 2 ? 'uncertain' : 'no'));
        const results = await Promise.all([
          ...outcomes.map((b) => ai.endAiAttempt(id, { billable: b, tokens: b === 'yes' ? 25 : 0 })),
          ai.settleAi(id, 'usage'),
          ai.settleAi(id, 'usage'),
          ai.settleAi(id, 'usage'),
        ]);
        const settles = results.slice(8);
        assert.equal(settles.filter((x) => x === 'settled').length, 1, `round ${round}: exactly one settlement (${settles})`);
        const now = await r.peekAi(key, day);
        const delta = now - charged;
        assert.ok(delta === 0 || delta === 1, `round ${round}: charge delta ${delta} (never more than the reserved unit, never negative)`);
        if (round % 3 !== 0) assert.equal(delta, 1, `round ${round}: a billable or uncertain attempt => charged, whatever the interleaving`);
        charged = now;
        if (db) {
          const row = (await db.pool.query('SELECT status, attempts_total, attempts_open, billable_attempts, uncertain_attempts, billable_tokens FROM ai_reservations WHERE id = $1', [id])).rows[0];
          assert.equal(row.attempts_total, 8);
          assert.equal(row.attempts_open, 0, 'every attempt end was recorded, also after the settlement');
          assert.equal(row.billable_attempts, round % 3 === 1 ? 1 : 0);
          assert.equal(row.uncertain_attempts, round % 3 === 2 ? 1 : 0);
          assert.equal(Number(row.billable_tokens), round % 3 === 1 ? 25 : 0);
          assert.equal(row.status === 'committed' ? 1 : 0, delta, 'the status matches the charge');
        }
        assert.equal(await ai.settleAi(id, 'usage'), 'already_settled');
        assert.equal(await r.peekAi(key, day), charged, 'a late settle changes nothing');
      }
    });
  });
}

// ---------------------------------------------------------------- R6: migration 0006 upgrade evidence
describe('Review R6 (postgres): migration 0006 on a real version-5 database', { skip: pgSkip }, () => {
  test('legacy rows keep their data and billing; an interrupted migration leaves version 5 intact; a re-run recovers; the previous release still runs', async () => {
    const { migrate } = await import('../server/db/migrate.ts');
    const v5dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1r-v5-'));
    for (const f of fs.readdirSync(MIGRATIONS)) if (/^000[1-5]_/.test(f)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(v5dir, f));
    assert.deepEqual(fs.readdirSync(v5dir).sort(), ['0001_initial.sql', '0002_ai_reservations.sql', '0003_render_queue.sql', '0004_captcha_redemptions.sql', '0005_ai_reservation_started.sql']);
    const db = await createTestDatabase({ migrate: false });
    dbs.push(db);
    const q = (sql: string, v: any[] = []) => db.pool.query(sql, v);
    const version = async () => Number((await q('SELECT max(version) AS v FROM schema_migrations')).rows[0].v);
    const hasColumn = async () => Number((await q("SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'ai_reservations' AND column_name = 'attempts_total'")).rows[0].n) === 1;

    // 1. a version-5 database (the previous release's schema), with rows in every state the previous release writes
    assert.equal((await migrate(db.pool, v5dir)).current, 5);
    await q(`INSERT INTO ai_reservations (id, day, keys, status, created_at, started_at, settled_at) VALUES
      ('r6-legacy-open',      current_date, ARRAY['user:r6'], 'reserved',  now() - interval '2 hours', NULL,                         NULL),
      ('r6-legacy-started',   current_date, ARRAY['user:r6'], 'reserved',  now() - interval '2 hours', now() - interval '2 hours', NULL),
      ('r6-legacy-committed', current_date, ARRAY['user:r6'], 'committed', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour'),
      ('r6-legacy-refunded',  current_date, ARRAY['user:r6'], 'refunded',  now() - interval '2 hours', NULL,                         now() - interval '1 hour')`);
    await q("INSERT INTO ai_usage_daily (day, key, count) VALUES (current_date, 'user:r6', 3)"); // open + started + committed
    const legacySnapshot = async () => (await q("SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM (SELECT id, day, keys, status, created_at, started_at, settled_at FROM ai_reservations WHERE id LIKE 'r6-legacy-%') t")).rows[0].h;
    const before = await legacySnapshot();

    // 2a. interruption: the table is busy; the migration's lock timeout fires -> nothing applied
    const blocker = new pg.Client({ connectionString: db.url });
    blocker.on('error', () => {}); // ended by the test; never an uncaught error during cleanup
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE ai_reservations IN ACCESS SHARE MODE');
    await assert.rejects(migrate(db.pool, MIGRATIONS, { lockTimeoutMs: 300 }), /0006_ai_reservation_attempts\.sql failed \(lock timeout/);
    assert.equal(await version(), 5);
    assert.equal(await hasColumn(), false, 'no partial schema after a failed migration');

    // 2b. interruption: the migrating PROCESS is killed while its ALTER waits for the lock
    const runner = path.join(v5dir, '..', `d1r-mig-${process.pid}.mts`);
    fs.writeFileSync(runner, `import { createPool } from ${JSON.stringify(path.join(ROOT, 'server/db/pool.ts'))};\nimport { migrate } from ${JSON.stringify(path.join(ROOT, 'server/db/migrate.ts'))};\nawait migrate(createPool(process.env.MIG_URL!, { applicationName: 'r6-killed-migration' }), undefined, { lockTimeoutMs: 120000 });\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', runner], { cwd: ROOT, env: { ...process.env, MIG_URL: db.url }, stdio: ['ignore', 'ignore', 'pipe'] });
    let childErr = '';
    child.stderr!.on('data', (d) => (childErr += d));
    let waiting = false;
    // up to 60 s: a fresh tsx process under a parallel test suite can take several seconds to start
    for (let i = 0; i < 1200 && !waiting && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      // the killed-to-be session holds an UNGRANTED lock on ai_reservations (its ALTER waits for the blocker). Matched on
      // pg_locks, not on the query text (pg_stat_activity.query is truncated to track_activity_query_size).
      waiting =
        Number(
          (
            await q(
              "SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'r6-killed-migration' AND NOT l.granted AND l.relation = 'ai_reservations'::regclass",
            )
          ).rows[0].n,
        ) === 1;
    }
    if (!waiting) child.kill('SIGKILL');
    assert.ok(waiting, `the migration is inside its transaction, waiting on the ALTER (child exit ${child.exitCode}; stderr: ${childErr.slice(-500)})`);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await blocker.query('COMMIT'); // the lock is released: the orphaned backend may now run the ALTER, but can never COMMIT
    await blocker.end();
    for (let i = 0; i < 200; i++) {
      if (Number((await q("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'r6-killed-migration'")).rows[0].n) === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(Number((await q("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'r6-killed-migration'")).rows[0].n), 0, 'the killed migration session is gone');
    assert.equal(await version(), 5, 'the killed migration committed nothing');
    assert.equal(await hasColumn(), false);

    // 3. recovery: a normal re-run applies 0006 exactly once
    const up = await migrate(db.pool, MIGRATIONS);
    assert.deepEqual([up.applied, up.current], [['0006_ai_reservation_attempts.sql'], 6]);
    assert.deepEqual((await migrate(db.pool, MIGRATIONS)).applied, [], 'idempotent');
    assert.equal(await legacySnapshot(), before, 'every legacy row is byte-identical in its existing columns');
    const zeros = (await q("SELECT count(*) AS n FROM ai_reservations WHERE id LIKE 'r6-legacy-%' AND attempts_total = 0 AND attempts_open = 0 AND billable_attempts = 0 AND uncertain_attempts = 0 AND billable_tokens = 0")).rows[0].n;
    assert.equal(Number(zeros), 4, 'new columns default to 0 on existing rows');

    // 4. the previous release against the version-6 schema: its migrator (this migrate.ts is unchanged since 6ee9c11,
    //    with only files 0001-0005) accepts the newer backward-compatible migration and applies nothing
    const prev = await migrate(db.pool, v5dir);
    assert.deepEqual([prev.applied, prev.newerCompatible], [[], ['0006_ai_reservation_attempts.sql']]);
    //    and its settle statement (verbatim from 614c56b) on a reservation begun by THIS release charges it
    const repo = new PostgresRepo(db.pool, limits);
    await repo.reserveAi([{ key: 'user:r6', limit: 100 }], aiDay(), 'r6-new-begun');
    assert.equal(await (repo as any).beginAiAttempt('r6-new-begun'), true);
    const old = await q(
      `UPDATE ai_reservations SET settled_at = now(),
         status = CASE WHEN $2 = 'commit' THEN 'committed' WHEN $2 = 'refund' THEN 'refunded'
                       WHEN started_at IS NULL THEN 'refunded' ELSE 'committed' END
       WHERE id = $1 AND status = 'reserved' RETURNING status`,
      ['r6-new-begun', 'abort'],
    );
    assert.equal(old.rows[0].status, 'committed', "the previous release's abort settles an in-flight attempt of this release as charged");

    // 5. this release on the legacy rows: recovery charges the started one, refunds the never-started one, leaves
    //    settled rows alone; the usage count follows (3 + 1 new - 1 refund = 3)
    assert.equal(await repo.expireAiReservations(1000), 2);
    const st = Object.fromEntries((await q("SELECT id, status FROM ai_reservations WHERE id LIKE 'r6-%' ORDER BY id")).rows.map((x: any) => [x.id, x.status]));
    assert.deepEqual(st, {
      'r6-legacy-committed': 'committed',
      'r6-legacy-open': 'refunded',
      'r6-legacy-refunded': 'refunded',
      'r6-legacy-started': 'committed',
      'r6-new-begun': 'committed',
    });
    assert.equal(await repo.peekAi('user:r6', aiDay()), 3);
  });
});

describe('Review R6 (json): ledger files written by the previous release', () => {
  test('a usage.json from the previous release loads; a started reservation is charged by recovery, a never-started one refunded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1r-jsonv5-'));
    const day = aiDay();
    const old = Date.now() - 3600000;
    // exactly the shape the previous release (614c56b) writes: v2, reservations with an optional 'started', no 'attempts'
    fs.writeFileSync(
      path.join(dir, 'usage.json'),
      JSON.stringify({ v: 2, day, counts: { 'user:r6j': 2 }, reservations: { 'r6j-open': { keys: ['user:r6j'], day, at: old }, 'r6j-started': { keys: ['user:r6j'], day, at: old, started: old } } }),
    );
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 1000);
    r.init();
    assert.equal(await r.peekAi('user:r6j', day), 2);
    assert.equal(await r.expireAiReservations(1000), 2);
    assert.equal(await r.peekAi('user:r6j', day), 1, 'started (previous release) -> charged; never started -> refunded');
    await r.close();
  });
});
