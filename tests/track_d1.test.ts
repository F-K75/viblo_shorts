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
// Owner decision: refund only if the model call provably has not started; charge once it started or when uncertain.
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
      assert.equal(await ai.settleAi('f10-res-0001', 'abort'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 0, 'never started: released');
      assert.equal(await ai.startAi('f10-res-0001'), false, 'a settled reservation can never start a model call');
      // started + client abort -> committed (charged)
      await r.reserveAi(AI_KEYS('f10'), day, 'f10-res-0002');
      assert.equal(await ai.startAi('f10-res-0002'), true, 'atomic transition into model-call-started');
      assert.equal(await ai.startAi('f10-res-0002'), false, 'the transition happens once');
      assert.equal(await ai.settleAi('f10-res-0002', 'abort'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 1, 'started: the charge is kept');
      assert.equal(await ai.settleAi('f10-res-0002', 'refund'), 'already_settled', 'exactly one final outcome');
      assert.equal(await r.peekAi('user:f10', day), 1);
      // a known failure after the start is still refunded (billing model unchanged for complete responses)
      await r.reserveAi(AI_KEYS('f10'), day, 'f10-res-0003');
      assert.equal(await ai.startAi('f10-res-0003'), true);
      assert.equal(await ai.settleAi('f10-res-0003', 'refund'), 'settled');
      assert.equal(await r.peekAi('user:f10', day), 1);
    });

    test('crash recovery: expiry refunds a reservation that never started and commits one that started (uncertain = charged)', async () => {
      const { r, dir } = await makeRepo(kind);
      const day = aiDay();
      const ai = r as any;
      await r.reserveAi(AI_KEYS('f10c'), day, 'f10-crash-not-started');
      await r.reserveAi(AI_KEYS('f10c'), day, 'f10-crash-started');
      assert.equal(await ai.startAi('f10-crash-started'), true);
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
      const [started, a1, a2, c] = await Promise.all([ai.startAi(id), ai.settleAi(id, 'abort'), ai.settleAi(id, 'abort'), i % 2 ? ai.settleAi(id, 'commit') : ai.settleAi(id, 'abort')]);
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
      // provider failure with a complete fallback response: refunded (unchanged)
      stub.delayMs = 0;
      stub.mode = 'fail';
      assert.equal((await call()).status, 200);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await used(), 2, 'failed call: refunded');
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
});
