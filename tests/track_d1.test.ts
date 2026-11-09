// Track D-1 (security and data hardening). One section per item; each was written red-first against the previous
// implementation (main @ 6ee9c11) before its fix.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRepo } from '../server/lib/jsonRepo.ts';
import { PostgresRepo } from '../server/db/pgRepo.ts';
import { ProjectOwnershipError, type Repo } from '../server/lib/repo.ts';
import type { StoreLimits } from '../server/lib/projectStore.ts';
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
const now = () => new Date().toISOString();
const proj = (id: string, userId: string, size = 10, extra: object = {}) => ({ id, userId, title: id, topic: 'x'.repeat(size), createdAt: now(), updatedAt: now(), ...extra });

const dbs: TestDb[] = [];
after(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
});
async function makeRepo(kind: 'json' | 'postgres'): Promise<{ r: Repo; db?: TestDb; dir?: string }> {
  if (kind === 'json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-json-'));
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 0);
    r.init();
    return { r, dir };
  }
  const db = await createTestDatabase();
  dbs.push(db);
  return { r: new PostgresRepo(db.pool, limits), db };
}

// ---------------------------------------------------------------- D4a / F8: project ownership in the save itself
for (const kind of ['json', 'postgres'] as const) {
  describe(`F8 (${kind}): saveProject enforces ownership and never resurrects a deleted project`, { skip: kind === 'postgres' ? pgSkip : false }, () => {
    test('an update that requires the project to exist does not re-create it after a concurrent delete', async () => {
      const { r, db } = await makeRepo(kind);
      const p = proj('proj_d1_upd', 'alice', 20);
      await r.saveProject('alice', p);
      // the route has already read the project (it existed); the owner deletes it before the save runs
      assert.equal(await r.deleteProject('alice', p.id), true);
      await assert.rejects(
        (r.saveProject as any)('alice', { ...p, title: 'late update' }, { mustExist: true }),
        (e: any) => e?.name === 'ProjectNotFoundError',
        'the late update is refused as "not found"',
      );
      assert.equal(await r.getProject(p.id), null, 'the deleted project was not re-created');
      assert.deepEqual(await r.listProjects('alice'), []);
      if (db) {
        const u = (await db.pool.query('SELECT project_count, storage_bytes FROM users WHERE id = $1', ['alice'])).rows[0];
        assert.deepEqual([Number(u.project_count), Number(u.storage_bytes)], [0, 0], 'counters are unchanged by the refused update');
      }
      // an update of an existing project with mustExist still works
      await r.saveProject('alice', proj('proj_d1_live', 'alice'));
      await (r.saveProject as any)('alice', { ...proj('proj_d1_live', 'alice'), title: 'renamed' }, { mustExist: true });
      assert.equal((await r.getProject('proj_d1_live'))!.project.title, 'renamed');
    });
  });
}

describe('F8 (postgres): concurrent saves of one new id by two users', { skip: pgSkip }, () => {
  test('exactly one user wins each race; the loser gets ProjectOwnershipError; documents and counters stay consistent', async () => {
    const { r, db } = await makeRepo('postgres');
    for (let round = 0; round < 10; round++) {
      const id = `proj_race_${round}`;
      const results = await Promise.allSettled([
        r.saveProject('alice', proj(id, 'alice', 100, { title: `alice-${round}` })),
        r.saveProject('bob', proj(id, 'bob', 300, { title: `bob-${round}` })),
      ]);
      const won = results.filter((x) => x.status === 'fulfilled').length;
      assert.equal(won, 1, `round ${round}: ${JSON.stringify(results.map((x) => x.status))}`);
      const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      assert.ok(lost.reason instanceof ProjectOwnershipError, `round ${round}: ${lost.reason}`);
      const row = (await db!.pool.query('SELECT user_id, title FROM projects WHERE id = $1', [id])).rows[0];
      assert.equal(row.title, `${row.user_id}-${round}`, `round ${round}: the document belongs to its owner (${JSON.stringify(row)})`);
    }
    // every user's counters equal what they actually own
    const drift = (
      await db!.pool.query(
        `SELECT u.id, u.project_count, u.storage_bytes, count(p.id)::int AS n, coalesce(sum(p.size_bytes), 0)::bigint AS bytes
           FROM users u LEFT JOIN projects p ON p.user_id = u.id GROUP BY u.id
         HAVING u.project_count <> count(p.id) OR u.storage_bytes <> coalesce(sum(p.size_bytes), 0)`,
      )
    ).rows;
    assert.deepEqual(drift, [], 'no counter drift');
    const totals = (await db!.pool.query("SELECT bytes FROM storage_totals WHERE scope = 'all'")).rows[0];
    const sum = (await db!.pool.query('SELECT coalesce(sum(size_bytes), 0)::bigint AS s FROM projects')).rows[0];
    assert.equal(String(totals.bytes), String(sum.s), 'the global storage total equals the stored projects');
  });
});

// ---------------------------------------------------------------- D4b / F9: counter rebuild under live writes and timeouts
describe('F9 (postgres): the data-migration counter rebuild', { skip: pgSkip }, () => {
  const emptySource = (extra: Array<{ ownerId: string; project: any }> = []) => ({ projects: extra, jobs: [], subscriptions: {}, usage: null, digest: `d1-${Date.now()}` });
  const drift = async (db: TestDb) =>
    (
      await db.pool.query(
        `SELECT u.id, u.project_count, u.storage_bytes, count(p.id)::int AS n, coalesce(sum(p.size_bytes), 0)::bigint AS bytes
           FROM users u LEFT JOIN projects p ON p.user_id = u.id GROUP BY u.id
         HAVING u.project_count <> count(p.id) OR u.storage_bytes <> coalesce(sum(p.size_bytes), 0)`,
      )
    ).rows;
  const totalsMatch = async (db: TestDb) => {
    const r = (
      await db.pool.query(
        `SELECT (SELECT bytes FROM storage_totals WHERE scope = 'all') AS all_t, (SELECT coalesce(sum(size_bytes), 0) FROM projects) AS all_s,
                (SELECT bytes FROM storage_totals WHERE scope = 'guest') AS guest_t,
                (SELECT coalesce(sum(p.size_bytes), 0) FROM projects p JOIN users u ON u.id = p.user_id WHERE u.kind = 'guest') AS guest_s`,
      )
    ).rows[0];
    return { all: [String(r.all_t), String(r.all_s)], guest: [String(r.guest_t), String(r.guest_s)] };
  };

  test('a live write that commits while the rebuild waits for its lock is not lost (no counter drift)', async () => {
    const { migrateJsonToPostgres } = await import('../server/db/dataMigration.ts');
    const { r, db } = await makeRepo('postgres');
    await r.saveProject('f9-live', proj('proj_f9_a', 'f9-live', 50));
    // a live save in flight: same statements as saveProject, holding the user's row lock
    const live = await db!.pool.connect();
    try {
      await live.query('BEGIN');
      await live.query("SELECT 1 FROM users WHERE id = 'f9-live' FOR UPDATE");
      const doc = JSON.stringify(proj('proj_f9_b', 'f9-live', 70));
      const size = Buffer.byteLength(doc);
      await live.query("INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at) VALUES ('proj_f9_b', 'f9-live', 'b', $1::jsonb, $2, now(), now())", [doc, size]);
      await live.query("UPDATE users SET storage_bytes = storage_bytes + $1, project_count = project_count + 1 WHERE id = 'f9-live'", [size]);
      await live.query("UPDATE storage_totals SET bytes = bytes + $1 WHERE scope = 'all'", [size]);
      const running = migrateJsonToPostgres(db!.pool, emptySource([{ ownerId: 'f9-src', project: proj('proj_f9_src', 'f9-src', 30) }]) as any);
      // wait until the migration is blocked on the live write's lock, then let the live write commit
      for (let i = 0; i < 100; i++) {
        const waiting = (await db!.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n;
        if (waiting > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await live.query('COMMIT');
      const report = await running;
      assert.equal(report.verification.ok, true);
    } finally {
      live.release();
    }
    assert.deepEqual(await drift(db!), [], 'every user counter equals what is stored');
    const t = await totalsMatch(db!);
    assert.equal(t.all[0], t.all[1], `global total ${t.all.join(' vs ')}`);
  });

  test('verification (after the fix): a migration interrupted inside the rebuild changes nothing; a re-run completes exactly', async () => {
    const { migrateJsonToPostgres } = await import('../server/db/dataMigration.ts');
    const db = await createTestDatabase();
    dbs.push(db);
    await db.pool.query("INSERT INTO users (id, kind) SELECT 'f9i_' || lpad(g::text, 4, '0'), 'firebase' FROM generate_series(1, 3000) g");
    await db.pool.query("INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at) SELECT 'proj_f9i_' || g, 'f9i_' || lpad((((g - 1) % 3000) + 1)::text, 4, '0'), 't', '{}'::jsonb, 100, now(), now() FROM generate_series(1, 6000) g");
    await db.pool.query('UPDATE users SET project_count = 0, storage_bytes = 0');
    // fault injection: the rebuild fails on a user in its third page (after two pages were already rewritten)
    await db.pool.query(`CREATE FUNCTION f9_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = 'f9i_2500' AND NEW.project_count > 0 THEN RAISE EXCEPTION 'injected failure inside the counter rebuild'; END IF; RETURN NEW; END $$`);
    await db.pool.query('CREATE TRIGGER f9_fault BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION f9_fault()');
    const src = emptySource([{ ownerId: 'f9i_new', project: proj('proj_f9i_new', 'f9i_new', 40) }]);
    await assert.rejects(migrateJsonToPostgres(db.pool, src as any), /injected failure inside the counter rebuild/);
    const after = (await db.pool.query("SELECT (SELECT count(*) FROM users WHERE project_count > 0)::int AS rebuilt, (SELECT count(*) FROM projects WHERE id = 'proj_f9i_new')::int AS inserted, (SELECT count(*) FROM data_migrations)::int AS runs")).rows[0];
    assert.deepEqual(after, { rebuilt: 0, inserted: 0, runs: 0 }, 'the whole migration rolled back: no partially rebuilt counters, no inserted rows, no run record');
    await db.pool.query('DROP TRIGGER f9_fault ON users');
    const report = await migrateJsonToPostgres(db.pool, src as any);
    assert.equal(report.verification.ok, true);
    assert.equal(report.inserted.projects, 1);
    assert.deepEqual(await drift(db), [], 're-run: exact counters for every user');
    const t = await totalsMatch(db);
    assert.equal(t.all[0], t.all[1]);
  });

  test('100 000 users and 200 000 projects: the rebuild finishes under a 400 ms statement timeout, with exact counters', async () => {
    const { migrateJsonToPostgres } = await import('../server/db/dataMigration.ts');
    const { createPool } = await import('../server/db/pool.ts');
    const db = await createTestDatabase();
    dbs.push(db);
    await db.pool.query("INSERT INTO users (id, kind) SELECT 'f9u_' || lpad(g::text, 6, '0'), CASE WHEN g % 10 = 0 THEN 'guest' ELSE 'firebase' END FROM generate_series(1, 100000) g");
    await db.pool.query(
      "INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at) SELECT 'proj_f9v_' || g, 'f9u_' || lpad((((g - 1) % 100000) + 1)::text, 6, '0'), 't', '{}'::jsonb, 100 + (g % 7), now(), now() FROM generate_series(1, 200000) g",
    );
    // counters deliberately wrong: the rebuild must make them exact
    await db.pool.query('UPDATE users SET project_count = 0, storage_bytes = 0');
    const saved = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '400';
    const tight = createPool(db.url);
    try {
      const report = await migrateJsonToPostgres(tight, emptySource() as any);
      assert.equal(report.verification.ok, true);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
      else process.env.DATABASE_STATEMENT_TIMEOUT_MS = saved;
      await tight.end();
    }
    assert.deepEqual(await drift(db), [], 'exact counters for all 100 000 users');
    const t = await totalsMatch(db);
    assert.equal(t.all[0], t.all[1]);
    assert.equal(t.guest[0], t.guest[1]);
  });
});

// ---------------------------------------------------------------- D4c / F10: AI reservation lifecycle
// Owner decision 2026-11-03, refined by review R2 (2026-11-09): settlement by actual provider usage. Here an attempt
// that began and has no recorded outcome is still open, which is charged (unknown outcome).
const AI_KEYS = (u: string) => [{ key: `user:${u}`, limit: 10 }];
const aiDay = () => Math.floor(Date.now() / 86400000);
for (const kind of ['json', 'postgres'] as const) {
  describe(`F10 (${kind}): AI reservation lifecycle`, { skip: kind === 'postgres' ? pgSkip : false }, () => {
    test('abort before the model started refunds; once started, abort charges; a refunded reservation can never start', async () => {
      const { r } = await makeRepo(kind);
      const day = aiDay();
      const ai = r as any;
      // not started + client abort -> refunded
      assert.deepEqual(await r.reserveAi(AI_KEYS('f10'), day, 'f10-res-0001'), { ok: true });
      assert.equal(await ai.settleAi('f10-res-0001', 'usage'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 0, 'never started: released');
      assert.equal(await ai.beginAiAttempt('f10-res-0001'), false, 'a settled reservation can never start a model call');
      // started + client abort -> committed (charged)
      await r.reserveAi(AI_KEYS('f10'), day, 'f10-res-0002');
      assert.equal(await ai.beginAiAttempt('f10-res-0002'), true, 'atomic transition into model-call-started');
      assert.equal(await ai.beginAiAttempt('f10-res-0002'), true, 'review R2: every provider attempt is recorded (retry / failover)');
      assert.equal(await ai.settleAi('f10-res-0002', 'usage'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 1, 'started: the charge is kept');
      assert.equal(await ai.settleAi('f10-res-0002', 'refund'), 'already_settled', 'exactly one final outcome');
      assert.equal(await r.peekAi('user:f10', day), 1);
      // an explicit refund (repository callers only; the request path settles by usage) still refunds
      await r.reserveAi(AI_KEYS('f10'), day, 'f10-res-0003');
      assert.equal(await ai.beginAiAttempt('f10-res-0003'), true);
      assert.equal(await ai.settleAi('f10-res-0003', 'refund'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 1);
    });

    test('crash recovery: expiry refunds a reservation that never started and commits one that started (uncertain = charged)', async () => {
      const { r, dir } = await makeRepo(kind);
      const day = aiDay();
      const ai = r as any;
      await r.reserveAi(AI_KEYS('f10c'), day, 'f10-crash-not-started');
      await r.reserveAi(AI_KEYS('f10c'), day, 'f10-crash-started');
      assert.equal(await ai.beginAiAttempt('f10-crash-started'), true);
      let recovered: any = r;
      if (kind === 'json') {
        // the process "crashes": a new repo over the same files (open reservations are persisted)
        await r.close(); // flushes the ledger, as the debounced flush would have
        recovered = new JsonRepo(dir!, path.join(dir!, 'backups'), limits, 0);
        recovered.init();
      }
      await new Promise((res) => setTimeout(res, 60));
      assert.equal(await recovered.expireAiReservations(30), 2, 'both stale reservations are settled');
      assert.equal(await recovered.peekAi('user:f10c', day), 1, 'only the started one stays charged');
      assert.equal(await recovered.settleAi('f10-crash-started', 'refund'), 'already_settled');
    });
  });
}

describe('F10 (postgres): concurrent start, abort and completion', { skip: pgSkip }, () => {
  test('40 rounds of start racing abort, commit and duplicate settles: one final outcome each, never a double refund or double charge', async () => {
    const { r, db } = await makeRepo('postgres');
    const ai = r as any;
    const day = aiDay();
    let expected = 0;
    for (let i = 0; i < 40; i++) {
      const id = `f10-race-${String(i).padStart(4, '0')}`;
      await r.reserveAi([{ key: 'user:f10r', limit: 1000 }], day, id);
      const [started, a1, a2, c] = await Promise.all([ai.beginAiAttempt(id), ai.settleAi(id, 'usage'), ai.settleAi(id, 'usage'), i % 2 ? ai.settleAi(id, 'commit') : ai.settleAi(id, 'usage')]);
      const settled = [a1, a2, c].filter((x) => x === 'settled').length;
      assert.equal(settled, 1, `round ${i}: exactly one settlement (${[a1, a2, c]})`);
      const row = (await db!.pool.query('SELECT status, started_at FROM ai_reservations WHERE id = $1', [id])).rows[0];
      if (row.status === 'refunded') assert.equal(started, false, `round ${i}: a refunded reservation never started`);
      if (started) assert.equal(row.status, 'committed', `round ${i}: a started reservation is never refunded by an abort`);
      if (row.status === 'committed') expected++;
    }
    assert.equal(await r.peekAi('user:f10r', day), expected, 'the usage count equals the committed reservations');
  });
});

describe('F10 (server, verification after the fix): settlement through the real request path', () => {
  test('a client that disconnects after the model call started is charged; completed and failed calls keep their rules', async () => {
    const { startTestServer } = await import('./helpers/server.ts');
    const { startGeminiStub } = await import('./helpers/geminiStub.ts');
    const stub = await startGeminiStub();
    const s = await startTestServer({ GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', LLM_TIMEOUT_MS: '8000' });
    try {
      const u = s.signFirebaseToken({ sub: 'f10-http' });
      const used = async () => (await (await fetch(`${s.baseUrl}/api/quota`, { headers: { authorization: `Bearer ${u}` } })).json()).dailyQuotaUsed;
      const call = (signal?: AbortSignal) =>
        fetch(`${s.baseUrl}/api/generate-script`, { method: 'POST', signal, headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'sleep habits' }) });
      // completed real output: charged
      assert.equal((await call()).status, 200);
      assert.equal(await used(), 1);
      // the model call starts (stub waits 2 s), then the client disconnects: still charged
      stub.delayMs = 2000;
      const before = stub.calls;
      const ac = new AbortController();
      const pending = call(ac.signal).catch(() => null);
      for (let i = 0; i < 100 && stub.calls === before; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(stub.calls, before + 1, 'the model call started');
      ac.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await used(), 2, 'abort after the start: charged');
      // provider error response (HTTP 500) with a complete fallback response: charged (owner decision 2026-11-09:
      // a provider error is an uncertain outcome; no refund on an unverified assumption about provider billing)
      stub.delayMs = 0;
      stub.mode = 'fail';
      assert.equal((await call()).status, 200);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await used(), 3, 'provider error: charged (conservative)');
    } finally {
      await s.stop();
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------- D4d / F11: backup integrity and TLS
describe('F11: backup verification covers ai_reservations (counts and content) and every backup connection follows the TLS policy', () => {
  const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const ageKey = async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-age-'));
    const file = path.join(dir, 'key.txt');
    execFileSync('age-keygen', ['-o', file], { stdio: 'ignore' });
    return { file, pub: /public key: (age1\w+)/.exec(fs.readFileSync(file, 'utf8'))![1] };
  };

  test('the manifest records ai_reservations (and captcha_redemptions) with counts and content checksums; restore verification catches missing and changed rows', { skip: pgSkip }, async () => {
    const offsite: any = await import('../server/db/offsiteBackup.ts');
    const src = await createTestDatabase();
    dbs.push(src);
    const r = new PostgresRepo(src.pool, limits);
    for (let i = 0; i < 5; i++) await r.reserveAi([{ key: 'user:f11', limit: 100 }], aiDay(), `f11-res-${String(i).padStart(4, '0')}`);
    await (r as any).settleAi('f11-res-0000', 'commit');
    const key = await ageKey();
    const cfg = { target: `file://${fs.mkdtempSync(path.join(os.tmpdir(), 'd1-bk-'))}`, allowFileTarget: true };
    const m = await offsite.createBackup(src.url, cfg, [key.pub]);
    assert.equal(m.rowCounts.ai_reservations, 5, `ai_reservations is counted: ${JSON.stringify(m.rowCounts)}`);
    assert.ok('captcha_redemptions' in m.rowCounts, 'captcha_redemptions is counted');
    assert.match(m.checksums?.ai_reservations ?? '', /^[0-9a-f]{32}$/, 'a content checksum per table');
    const dst = await createTestDatabase({ migrate: false });
    dbs.push(dst);
    const restored = await offsite.restoreBackup(cfg, m.name, dst.url, key.file);
    assert.equal(restored.verified, true);
    // incomplete restore: a missing row is reported
    await dst.pool.query("DELETE FROM ai_reservations WHERE id = 'f11-res-0004'");
    const missing = await offsite.verifyRestoredDatabase(cfg, m.name, dst.url);
    assert.equal(missing.state, 'mismatch');
    assert.deepEqual(missing.differences.filter((d: any) => d.table === 'ai_reservations'), [{ table: 'ai_reservations', expected: 5, actual: 4 }]);
    // corrupted content with the same row count: also reported
    await dst.pool.query("INSERT INTO ai_reservations (id, day, keys, status) VALUES ('f11-res-0004', now()::date, ARRAY['user:f11'], 'reserved')");
    await dst.pool.query("UPDATE ai_reservations SET status = 'refunded', settled_at = now() WHERE id = 'f11-res-0000'");
    const changed = await offsite.verifyRestoredDatabase(cfg, m.name, dst.url);
    assert.equal(changed.state, 'mismatch', JSON.stringify(changed.differences));
    assert.ok(changed.differences.some((d: any) => d.table === 'ai_reservations' && d.contentChanged === true), JSON.stringify(changed.differences));
  });

  test('libpqEnv applies the TLS policy to pg_dump / pg_restore / psql (never libpq\'s plaintext-allowing default)', async () => {
    const { libpqEnv } = await import('../server/db/offsiteBackup.ts');
    const base = 'postgres://u:p@db.example.com:5432/forge';
    await withEnv({ NODE_ENV: 'production', DATABASE_SSLMODE: undefined, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined }, () => {
      const e = libpqEnv(base);
      assert.equal(e.PGSSLMODE, 'verify-full', 'production default: verified TLS');
      assert.equal(e.PGSSLROOTCERT, 'system', "verified against the system CA store unless a root certificate is given");
    });
    await withEnv({ NODE_ENV: 'test', DATABASE_SSLMODE: 'require', DATABASE_SSL_REJECT_UNAUTHORIZED: undefined }, () => assert.equal(libpqEnv(base).PGSSLMODE, 'verify-full'));
    await withEnv({ NODE_ENV: 'production', DATABASE_SSLMODE: undefined, DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }, () => assert.equal(libpqEnv(base).PGSSLMODE, 'require'));
    await withEnv({ NODE_ENV: 'production', DATABASE_SSLMODE: undefined }, () => {
      assert.equal(libpqEnv(`${base}?sslmode=disable`).PGSSLMODE, 'disable', 'an explicit disable is honoured, as in the app');
      assert.equal(libpqEnv(`${base}?sslmode=prefer`).PGSSLMODE, 'verify-full', 'a plaintext-allowing mode is upgraded, as in the app');
      const ca = libpqEnv(`${base}?sslmode=verify-full&sslrootcert=/ca.pem`);
      assert.deepEqual([ca.PGSSLMODE, ca.PGSSLROOTCERT], ['verify-full', '/ca.pem']);
    });
  });

  test('when TLS is required, the backup tool refuses a server without TLS instead of falling back to plaintext', { skip: pgSkip }, async () => {
    const offsite: any = await import('../server/db/offsiteBackup.ts');
    const db = await createTestDatabase();
    dbs.push(db);
    const plain = db.url.replace(/[?&]sslmode=disable/, ''); // the local test server has ssl = off
    for (const vars of [{ DATABASE_SSLMODE: 'require', NODE_ENV: 'test' }, { DATABASE_SSLMODE: undefined, NODE_ENV: 'production' }]) {
      await withEnv(vars, async () => {
        await assert.rejects(offsite.rowCounts(plain), /SSL|TLS/i, `rowCounts under ${JSON.stringify(vars)}`);
        const key = await ageKey();
        const cfg = { target: `file://${fs.mkdtempSync(path.join(os.tmpdir(), 'd1-bk-tls-'))}`, allowFileTarget: true };
        await assert.rejects(offsite.createBackup(plain, cfg, [key.pub]), /SSL|TLS/i, `createBackup under ${JSON.stringify(vars)}`);
      });
    }
  });

  // ---- Review R4 (owner decision 2026-11-09): TLS-required restore and verify-restore, tested end to end ----
  const tlsBackup = async () => {
    const offsite: any = await import('../server/db/offsiteBackup.ts');
    const src = await createTestDatabase();
    dbs.push(src);
    const r = new PostgresRepo(src.pool, limits);
    for (let i = 0; i < 3; i++) await r.reserveAi([{ key: 'user:r4', limit: 100 }], aiDay(), `r4-res-${String(i).padStart(4, '0')}`);
    const key = await ageKey();
    const cfg = { target: `file://${fs.mkdtempSync(path.join(os.tmpdir(), 'd1-r4-'))}`, allowFileTarget: true };
    const m = await offsite.createBackup(src.url, cfg, [key.pub]); // source side: the local test server (TLS off)
    const dst = await createTestDatabase({ migrate: false });
    dbs.push(dst);
    return { offsite, cfg, m, key, dst };
  };
  const tablesIn = async (db: TestDb) => Number((await db.pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n);
  const TLS_REQUIRED = { DATABASE_SSLMODE: 'require', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', NODE_ENV: 'test' };

  test('R4: restore and verify-restore with TLS required: every connection (Node client and psql) negotiates TLS; none is plaintext', { skip: pgSkip }, async () => {
    const { startPgTlsProxy } = await import('./helpers/pgTlsProxy.ts');
    const { offsite, cfg, m, key, dst } = await tlsBackup();
    const proxy = await startPgTlsProxy(dst.url);
    try {
      await withEnv(TLS_REQUIRED, async () => {
        const restored = await offsite.restoreBackup(cfg, m.name, proxy.url, key.file);
        assert.equal(restored.verified, true, 'the restore through TLS completes and verifies');
        const check = await offsite.verifyRestoredDatabase(cfg, m.name, proxy.url);
        assert.equal(check.state, 'complete', JSON.stringify(check.differences));
      });
      const c = proxy.connections;
      assert.ok(c.length >= 5, `restore (target check, server version, psql, verification) + verify-restore: ${JSON.stringify(c)}`);
      assert.deepEqual(c.filter((x) => !x.tls || x.plaintext), [], 'no connection without TLS');
      const apps = new Set(c.map((x) => x.app));
      assert.ok(apps.has('psql'), `the libpq restore stage (psql) used TLS: ${[...apps]}`);
      assert.ok(apps.has('forge-backup-verify'), `the Node connections used TLS: ${[...apps]}`);
    } finally {
      await proxy.close();
    }
  });

  test('R4: with TLS required, restore and verify-restore refuse a server without TLS, and the target stays untouched', { skip: pgSkip }, async () => {
    const { offsite, cfg, m, key, dst } = await tlsBackup();
    const plain = dst.url.replace(/[?&]sslmode=disable/, ''); // the local test server has ssl = off
    for (const vars of [TLS_REQUIRED, { DATABASE_SSLMODE: undefined, DATABASE_SSL_REJECT_UNAUTHORIZED: undefined, NODE_ENV: 'production' }]) {
      await withEnv(vars, async () => {
        await assert.rejects(offsite.restoreBackup(cfg, m.name, plain, key.file), /SSL|TLS/i, `restore under ${JSON.stringify(vars)}`);
        await assert.rejects(offsite.verifyRestoredDatabase(cfg, m.name, plain), /SSL|TLS/i, `verify-restore under ${JSON.stringify(vars)}`);
      });
    }
    assert.equal(await tablesIn(dst), 0, 'nothing was restored over a plaintext connection');
  });

  test('R4: a TLS downgrade at the libpq stage (the server refuses TLS only for the psql connection) aborts the restore; nothing is written', { skip: pgSkip }, async () => {
    const { startPgTlsProxy } = await import('./helpers/pgTlsProxy.ts');
    const { offsite, cfg, m, key, dst } = await tlsBackup();
    // restore connects in this order: target check (Node), server version (Node), psql. TLS is stripped on the 3rd
    // connection, and a plaintext client would be forwarded (an attacker accepting a downgrade).
    const proxy = await startPgTlsProxy(dst.url, { stripTlsOn: [3], forwardPlaintext: true });
    try {
      await withEnv(TLS_REQUIRED, async () => {
        await assert.rejects(offsite.restoreBackup(cfg, m.name, proxy.url, key.file), /SSL|TLS/i);
      });
      assert.equal(proxy.connections[2]?.tls, false, `the 3rd connection had TLS stripped: ${JSON.stringify(proxy.connections)}`);
      assert.deepEqual(proxy.connections.filter((x) => x.plaintext), [], 'psql did not fall back to plaintext');
      assert.equal(await tablesIn(dst), 0, 'the target is untouched');
    } finally {
      await proxy.close();
    }
  });
});

// ---------------------------------------------------------------- D6: one accepted representation per guest token
describe('D6: guest tokens have exactly one accepted encoding', () => {
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  /** Every non-canonical spelling of `part` that Node's lenient base64url decoder maps to the same bytes. */
  const variants = (part: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const last = part.at(-1)!;
    const idx = B64URL.indexOf(last);
    // 32 bytes -> 43 chars: the last char carries 4 data bits + 2 unused bits; flipping the unused bits keeps the bytes
    for (const flip of [1, 2, 3]) out.push([`unused bits ${flip}`, part.slice(0, -1) + B64URL[idx ^ flip]]);
    out.push(['= padding', `${part}=`]);
    out.push(['standard alphabet', part.replace(/-/g, '+').replace(/_/g, '/')]);
    out.push(['embedded newline', `${part.slice(0, 10)}\n${part.slice(10)}`]);
    return out.filter(([, v]) => v !== part);
  };

  test('AuthService: canonical tokens verify; every alternative encoding of the same signature (or body) is rejected', async () => {
    const { AuthService } = await import('../server/lib/auth.ts');
    const auth = new AuthService('d6-secret-'.padEnd(48, 'x'), undefined);
    for (let n = 0; n < 50; n++) {
      const { token, userId } = auth.issueGuestToken();
      assert.equal(auth.verifyGuestToken(token)?.userId, userId, 'a canonical token from the current implementation verifies');
      const [, body, sig] = token.split('.');
      for (const [why, alt] of variants(sig)) {
        if (Buffer.compare(Buffer.from(alt, 'base64url'), Buffer.from(sig, 'base64url')) !== 0) continue; // not the same bytes: not a re-encoding
        assert.equal(auth.verifyGuestToken(`guest.${body}.${alt}`), null, `signature re-encoded (${why}) must be rejected`);
      }
      for (const [why, alt] of variants(body)) assert.equal(auth.verifyGuestToken(`guest.${alt}.${sig}`), null, `body re-encoded (${why}) must be rejected`);
    }
    for (const bad of ['', 'guest', 'guest..', 'guest.a.b.c', 'guest.!!!.###', `guest.${'A'.repeat(10)}.`]) assert.equal(auth.verifyGuestToken(bad), null, `malformed: ${JSON.stringify(bad)}`);
  });

  test('server: a non-canonical guest token gets exactly the normal invalid-token response', async () => {
    const { startTestServer, guestToken } = await import('./helpers/server.ts');
    const s = await startTestServer();
    try {
      const token = await guestToken(s.baseUrl);
      const [, body, sig] = token.split('.');
      const me = (t: string) => fetch(`${s.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${t}` } });
      assert.equal((await me(token)).status, 200);
      const garbage = await me(`guest.${body}.${'A'.repeat(43)}`);
      const expected = { status: garbage.status, body: await garbage.text() };
      assert.equal(expected.status, 401);
      for (const [why, alt] of variants(sig)) {
        if (Buffer.compare(Buffer.from(alt, 'base64url'), Buffer.from(sig, 'base64url')) !== 0 || alt.includes('\n')) continue;
        const r = await me(`guest.${body}.${alt}`);
        assert.deepEqual({ status: r.status, body: await r.text() }, expected, `re-encoded signature (${why}): same response as any invalid token`);
      }
    } finally {
      await s.stop();
    }
  });
});

// ---------------------------------------------------------------- D-1 gate finding: guest-refusal stats were fire-and-forget
// Found by the D-1 full PostgreSQL gate on 3aa217c (Track A test "shared-network refusals ... recorded apart" read the
// stats before the refusal's own write had committed). A trigger delays only the refusal-stat writes, which makes the
// ordering deterministic: before the fix the 429 was sent first and the diagnostics did not see the refusal yet.
describe('Gate finding (postgres): a guest-mint refusal is recorded before the refusal is answered', { skip: pgSkip }, () => {
  test('IP refusals and CAPTCHA failures are visible in the diagnostics as soon as the client has its answer', async () => {
    const crypto = await import('node:crypto');
    const pg = (await import('pg')).default;
    const { startTestServer, healthDetails } = await import('./helpers/server.ts');
    const { startTurnstileStub } = await import('./helpers/turnstileStub.ts');
    const secret = `gate-secret-${crypto.randomBytes(8).toString('hex')}`;
    const v = await startTurnstileStub({ secret, hostname: 'forge.test' });
    // Always PostgreSQL (the race is between pooled connections), also when the suite runs with JSON servers.
    const db = await createTestDatabase({ migrate: false });
    await db.pool.end();
    dbs.push(db);
    const s = await startTestServer({
      DATABASE_URL: db.url,
      CAPTCHA_REQUIRED: 'true',
      TURNSTILE_SECRET: secret,
      TURNSTILE_SITE_KEY: '1x-gate-site-key',
      TURNSTILE_HOSTNAMES: 'forge.test',
      TURNSTILE_VERIFY_URL: v.url,
      TRUST_PROXY: '1',
      BACKUP_INTERVAL_HOURS: '0',
      GUEST_MINT_PER_IP_PER_HOUR: '1',
    });
    const c = new pg.Client({ connectionString: s.databaseUrl });
    try {
      await c.connect();
      await c.query(`CREATE FUNCTION gate_slow_stat() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF starts_with(NEW.key, 'stats:guest-reject:') OR starts_with(NEW.key, 'stats:guest-network-') THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$`);
      await c.query('CREATE TRIGGER gate_slow_stat BEFORE INSERT OR UPDATE ON window_counters FOR EACH ROW EXECUTE FUNCTION gate_slow_stat()');
      const mint = (ip: string, token: string) =>
        fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ 'cf-turnstile-response': token }) });
      const ok = () => `ok-${crypto.randomBytes(9).toString('hex')}`;
      assert.equal((await mint('203.0.113.9', ok())).status, 200);
      const refused = await mint('203.0.113.9', ok());
      assert.equal(refused.status, 429);
      assert.equal((await refused.json()).scope, 'ip');
      let g = (await healthDetails(s.baseUrl)).guestMints;
      assert.equal(g.rejected['guest_rate_limited:ip'], 1, 'the IP refusal is recorded before the 429 is sent');
      assert.equal(g.networkRefusals.thisHour.ip, 1, 'the shared-network refusal is recorded before the 429 is sent');
      const bad = await mint('203.0.113.77', `bad-${crypto.randomBytes(9).toString('hex')}`);
      assert.notEqual(bad.status, 200);
      g = (await healthDetails(s.baseUrl)).guestMints;
      assert.equal(g.rejected.captcha_failed, 1, 'the CAPTCHA failure is recorded before it is answered');
    } finally {
      await c.end().catch(() => {});
      await s.stop();
      await v.close();
    }
  });
});

// ---------------------------------------------------------------- D-1 review pass (owner decisions of 2026-11-09)
// R1: F10 on the JSON backend. The ledger is written on a 1 s debounce (production setting). A crash right after the
// model call started must not lose "started": otherwise recovery refunds a call that may have run (and cost money).
describe('Review R1 (json): the model-call start is durable before the provider is called', () => {
  test('a crash (no flush, no close) right after the start: recovery does not refund', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-r1-'));
    const r = new JsonRepo(dir, path.join(dir, 'backups'), limits, 1000); // production debounce
    r.init();
    const day = aiDay();
    assert.deepEqual(await r.reserveAi(AI_KEYS('r1'), day, 'r1-res-0001'), { ok: true });
    await new Promise((res) => setTimeout(res, 1300)); // the reservation itself reaches disk via the debounced flush
    assert.equal(await (r as any).beginAiAttempt('r1-res-0001'), true);
    // crash: the process dies now. No close(), no flush; the debounce timer never fires in the dead process.
    const recovered = new JsonRepo(dir, path.join(dir, 'backups'), limits, 1000);
    recovered.init();
    assert.equal(await recovered.expireAiReservations(0), 1, 'the open reservation is recovered and settled');
    assert.equal(await recovered.peekAi('user:r1', day), 1, 'a call that started (may have cost money) is not refunded');
    await recovered.close();
  });
});

// R2: F10 billing follows actual provider usage (owner decision 2026-11-09). A recorded start alone no longer charges:
//  * never started -> refund; a provider response with usage > 0 -> charge (also when its output is unusable);
//  * a response reporting 0 tokens -> not billable;
//  * a provider error response (HTTP 4xx/5xx) -> uncertain, charged (owner decision 2026-11-09: no refund on an
//    unverified assumption about provider billing);
//  * an attempt whose outcome is unknown (timeout, network error, crash, no usage metadata) -> charged (uncertain);
//  * failover: every attempt is tracked; the reservation's single unit is charged if any attempt was billable or uncertain.
describe('Review R2 (server): settlement by actual provider usage', () => {
  test('each provider outcome settles by its usage; failover is tracked per attempt; a disconnect waits for the attempt', async () => {
    const { startTestServer } = await import('./helpers/server.ts');
    const { startGeminiStub } = await import('./helpers/geminiStub.ts');
    const stub = await startGeminiStub();
    const s = await startTestServer({ GEMINI_API_KEY: 'stub-key-0123456789', GEMINI_BASE_URL: stub.baseUrl, GEMINI_MODELS: 'stub-model', LLM_TIMEOUT_MS: '600' });
    const pgc = s.databaseUrl ? new (await import('pg')).default.Client({ connectionString: s.databaseUrl }) : null;
    try {
      if (pgc) await pgc.connect();
      const u = s.signFirebaseToken({ sub: 'r2-http' });
      const used = async () => (await (await fetch(`${s.baseUrl}/api/quota`, { headers: { authorization: `Bearer ${u}` } })).json()).dailyQuotaUsed;
      const call = (signal?: AbortSignal) =>
        fetch(`${s.baseUrl}/api/generate-script`, { method: 'POST', signal, headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'sleep habits' }) });
      const settleWait = () => new Promise((r) => setTimeout(r, 300));
      let n = await used();
      const expectCharge = async (charged: boolean, why: string) => {
        await settleWait();
        n += charged ? 1 : 0;
        assert.equal(await used(), n, why);
      };
      // a response with usage but unusable output: billable, charged (the user gets the template fallback)
      stub.mode = 'garbage';
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'provider returned usage (30 tokens): charged although the output was unusable');
      // a response that reports zero usage: not billable, refunded
      stub.mode = 'zero';
      assert.equal((await call()).status, 200);
      await expectCharge(false, 'provider reported 0 tokens: refunded');
      // a response without usage metadata: uncertain, charged
      stub.mode = 'nousage';
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'no usage metadata: uncertain, charged');
      // provider error responses on every attempt: uncertain, charged once (conservative policy)
      stub.mode = 'fail';
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'HTTP 500 on every attempt: charged once (conservative)');
      stub.mode = 'fail4xx';
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'HTTP 400 from the provider: charged (conservative)');
      // failover: the first attempt fails (500), the retry succeeds: one unit, both attempts tracked
      stub.mode = 'ok';
      stub.queue = ['fail', 'ok'];
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'retry succeeded: charged once');
      if (pgc) {
        const row = (await pgc.query("SELECT status, attempts_total, attempts_open, billable_attempts, uncertain_attempts, billable_tokens FROM ai_reservations WHERE status <> 'reserved' ORDER BY created_at DESC LIMIT 1")).rows[0];
        assert.deepEqual(
          { ...row, billable_tokens: Number(row.billable_tokens) },
          { status: 'committed', attempts_total: 2, attempts_open: 0, billable_attempts: 1, uncertain_attempts: 0, billable_tokens: 30 },
          'both attempts and the billable tokens are recorded',
        );
      }
      // timeouts (the provider may have processed the request): uncertain, charged
      stub.mode = 'ok';
      stub.delayMs = 1000;
      assert.equal((await call()).status, 200);
      await expectCharge(true, 'attempts timed out: uncertain, charged');
      // the client disconnects while an attempt is in flight; the provider then answers with an error.
      // Settlement waits for the attempt's outcome (an error: uncertain, charged); no further attempt after the disconnect.
      await new Promise((r) => setTimeout(r, 1200)); // let the timed-out stub requests drain
      stub.mode = 'fail';
      stub.delayMs = 400;
      const before = stub.calls;
      const ac = new AbortController();
      const pending = call(ac.signal).catch(() => null);
      for (let i = 0; i < 100 && stub.calls === before; i++) await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(stub.calls, before + 1, 'no provider call after the client left');
      await expectCharge(true, 'disconnect during an attempt that then failed with HTTP 500: charged (conservative)');
    } finally {
      await pgc?.end().catch(() => {});
      await s.stop();
      await stub.close();
    }
  });
});

for (const kind of ['json', 'postgres'] as const) {
  describe(`Review R2 (${kind}): attempt lifecycle in the repository`, { skip: kind === 'postgres' ? pgSkip : false }, () => {
    test('begin/end attempts, settlement by usage, crash recovery, idempotency', async () => {
      const { r } = await makeRepo(kind);
      const ai = r as any;
      const day = aiDay();
      const k = 'user:r2r';
      const keys = [{ key: k, limit: 100 }];
      const charged = async () => r.peekAi(k, day);
      // never started -> refunded; a settled reservation can never begin an attempt
      await r.reserveAi(keys, day, 'r2-res-a');
      assert.equal(await ai.settleAi('r2-res-a', 'usage'), 'settled');
      assert.equal(await charged(), 0);
      assert.equal(await ai.beginAiAttempt('r2-res-a'), false);
      // an attempt that ended with a provider error -> refunded
      await r.reserveAi(keys, day, 'r2-res-b');
      assert.equal(await ai.beginAiAttempt('r2-res-b'), true);
      await ai.endAiAttempt('r2-res-b', { billable: 'no', tokens: 0 });
      assert.equal(await ai.settleAi('r2-res-b', 'usage'), 'settled');
      assert.equal(await charged(), 0, 'started, provider answered with an error: refunded');
      // billable attempt -> committed; duplicate settles and late attempt ends change nothing
      await r.reserveAi(keys, day, 'r2-res-c');
      assert.equal(await ai.beginAiAttempt('r2-res-c'), true);
      await ai.endAiAttempt('r2-res-c', { billable: 'yes', tokens: 42 });
      assert.equal(await ai.settleAi('r2-res-c', 'usage'), 'settled');
      assert.equal(await ai.settleAi('r2-res-c', 'usage'), 'already_settled');
      await ai.endAiAttempt('r2-res-c', { billable: 'no', tokens: 0 });
      assert.equal(await charged(), 1);
      // uncertain attempt -> committed
      await r.reserveAi(keys, day, 'r2-res-d');
      assert.equal(await ai.beginAiAttempt('r2-res-d'), true);
      await ai.endAiAttempt('r2-res-d', { billable: 'uncertain', tokens: 0 });
      assert.equal(await ai.settleAi('r2-res-d', 'usage'), 'settled');
      assert.equal(await charged(), 2);
      // crash while an attempt is in flight: recovery does not refund
      await r.reserveAi(keys, day, 'r2-res-e');
      assert.equal(await ai.beginAiAttempt('r2-res-e'), true);
      // crash after an attempt definitively failed and before settlement: recovery refunds (no billable usage)
      await r.reserveAi(keys, day, 'r2-res-f');
      assert.equal(await ai.beginAiAttempt('r2-res-f'), true);
      await ai.endAiAttempt('r2-res-f', { billable: 'no', tokens: 0 });
      await new Promise((res) => setTimeout(res, 40));
      assert.equal(await r.expireAiReservations(10), 2);
      assert.equal(await charged(), 3, 'in-flight attempt at the crash: charged; failed attempt: refunded');
    });
  });
}

describe('Review R2 (postgres): legacy rows and concurrency', { skip: pgSkip }, () => {
  test('a reservation started by the previous release (started_at set, no attempt records) is never refunded by recovery', async () => {
    const { r, db } = await makeRepo('postgres');
    const day = aiDay();
    await r.reserveAi([{ key: 'user:r2l', limit: 10 }], day, 'r2-legacy');
    await db!.pool.query("UPDATE ai_reservations SET started_at = now() - interval '1 hour', created_at = now() - interval '1 hour' WHERE id = 'r2-legacy'");
    assert.equal(await r.expireAiReservations(1000), 1);
    assert.equal(await r.peekAi('user:r2l', day), 1, 'legacy started row: uncertain, charged');
  });

  test('40 rounds of attempt begin racing settlement: an attempt that began is never refunded while open; a refunded reservation never began', async () => {
    const { r, db } = await makeRepo('postgres');
    const ai = r as any;
    const day = aiDay();
    let committed = 0;
    for (let i = 0; i < 40; i++) {
      const id = `r2-race-${String(i).padStart(4, '0')}`;
      await r.reserveAi([{ key: 'user:r2race', limit: 1000 }], day, id);
      const [begun, s1, s2] = await Promise.all([ai.beginAiAttempt(id), ai.settleAi(id, 'usage'), ai.settleAi(id, 'usage')]);
      assert.equal([s1, s2].filter((x) => x === 'settled').length, 1, `round ${i}: one settlement`);
      const row = (await db!.pool.query('SELECT status FROM ai_reservations WHERE id = $1', [id])).rows[0];
      if (begun) assert.equal(row.status, 'committed', `round ${i}: settled while the attempt was open -> charged`);
      else assert.equal(row.status, 'refunded', `round ${i}: never began -> refunded`);
      if (row.status === 'committed') committed++;
    }
    assert.equal(await r.peekAi('user:r2race', day), committed);
  });
});
