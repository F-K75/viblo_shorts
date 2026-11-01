// Hardening regressions found by the independent re-audit (R-11, R-12, R-14).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, pgSkip, PG_ADMIN_URL, type TestDb } from './helpers/pg.ts';
import { startS3Stub } from './helpers/s3Stub.ts';
import { createBackup, libpqEnv, restoreBackup } from '../server/db/offsiteBackup.ts';
import { startTestServer, HEALTH_TOKEN, healthDetails } from './helpers/server.ts';

const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('R-11: database credentials never appear in process arguments', () => {
  test('libpqEnv maps a URL (percent-encoded password, TLS params) to env vars and rejects unknown params', () => {
    const env = libpqEnv('postgres://forge%40app:p%40ss%3Aw0rd%2F%3F@db.example.com:6543/forge?sslmode=verify-full&sslrootcert=/ca.pem&application_name=bk');
    assert.deepEqual(env, {
      PGHOST: 'db.example.com',
      PGPORT: '6543',
      PGUSER: 'forge@app',
      PGPASSWORD: 'p@ss:w0rd/?',
      PGDATABASE: 'forge',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/ca.pem',
      PGAPPNAME: 'bk',
    });
    assert.throws(() => libpqEnv('postgres://u:p@h/db?host=evil'), /unsupported DATABASE_URL parameter/);
    assert.throws(() => libpqEnv('mysql://u:p@h/db'), /postgres:\/\//);
  });

  test('backup and restore run end to end while every pg tool argv is password-free', { skip: pgSkip }, async () => {
    // A real role with a password, used through a URL that carries it.
    const role = `forge_bk_${crypto.randomBytes(3).toString('hex')}`;
    const password = `Pw-${crypto.randomBytes(9).toString('hex')}`;
    const admin = new pg.Client({ connectionString: PG_ADMIN_URL.replace(/[?&]sslmode=disable/, '') });
    await admin.connect();
    await admin.query(`CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${password}'`);
    cleanups.push(async () => {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end();
    });
    const src: TestDb = await createTestDatabase();
    const dst: TestDb = await createTestDatabase({ migrate: false });
    cleanups.push(() => src.drop(), () => dst.drop());
    await src.pool.query("INSERT INTO users (id, kind) VALUES ('argv-user', 'firebase')");
    const withCreds = (u: string) => {
      const x = new URL(u);
      x.username = role;
      x.password = password;
      return x.toString();
    };

    // Wrap the real binaries: record argv (and whether a password arrived via env) for every invocation.
    const dir = tmp('argv-');
    const log = path.join(dir, 'argv.log');
    for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      const wrapper = path.join(dir, tool);
      fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s ARGV:' "${tool}" >> "${log}"\nfor a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done\nprintf ' PGPASSWORD_SET=%s\\n' "\${PGPASSWORD:+yes}" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
      process.env[`${tool.toUpperCase()}_PATH`] = wrapper;
    }
    cleanups.push(async () => {
      for (const tool of ['pg_dump', 'pg_restore', 'psql']) delete process.env[`${tool.toUpperCase()}_PATH`];
    });

    const s3 = await startS3Stub();
    cleanups.push(() => s3.close());
    process.env.AWS_ACCESS_KEY_ID ||= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
    const keyDir = tmp('argv-age-');
    execFileSync('age-keygen', ['-o', path.join(keyDir, 'k.txt')], { stdio: 'ignore' });
    const pub = /public key: (age1\w+)/.exec(fs.readFileSync(path.join(keyDir, 'k.txt'), 'utf8'))![1];
    const cfg = { target: 's3://argv-test/x', s3Endpoint: s3.endpoint, s3Region: 'us-east-1' };

    const m = await createBackup(withCreds(src.url), cfg, [pub]);
    const r = await restoreBackup(cfg, m.name, withCreds(dst.url), path.join(keyDir, 'k.txt'));
    assert.equal(r.verified, true, 'restore still works with env-based connection settings');
    assert.equal(r.rowCounts.users, 1);

    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(lines.some((l) => l.startsWith('pg_dump ')) && lines.some((l) => l.startsWith('psql ')), `tools were invoked: ${lines.join(' | ')}`);
    for (const l of lines) {
      assert.ok(!l.includes(password), `password leaked into argv: ${l.replace(password, '***')}`);
      assert.ok(!/postgres(ql)?:\/\//.test(l), `connection URL in argv: ${l}`);
    }
    assert.ok(lines.filter((l) => /^(pg_dump|psql) /.test(l)).every((l) => l.endsWith('PGPASSWORD_SET=yes')), 'password delivered via the environment');
  });
});

describe('R-12: public probes are minimal, cheap and throttled; diagnostics are gated', () => {
  test('no internals in public responses; details 404 without the token or with a wrong one', async () => {
    const s = await startTestServer({ PROBE_RATE_LIMIT_PER_MIN: '600' });
    cleanups.push(() => s.stop());
    const pub = await (await fetch(`${s.baseUrl}/api/health`)).text();
    assert.equal(pub, '{"status":"ok"}');
    assert.equal(await (await fetch(`${s.baseUrl}/api/live`)).text(), '{"status":"ok"}');
    const ready = await (await fetch(`${s.baseUrl}/api/ready`)).json();
    assert.deepEqual(Object.keys(ready).sort(), ['checks', 'ready']);
    for (const body of [pub, JSON.stringify(ready), await (await fetch(`${s.baseUrl}/api/config`)).text()]) {
      assert.doesNotMatch(body, /instance|hostname|pool|heap|rss|guestMints|proxy|gemini-|model/i);
    }
    assert.equal((await fetch(`${s.baseUrl}/api/health/details`)).status, 404);
    assert.equal((await fetch(`${s.baseUrl}/api/health/details`, { headers: { authorization: `Bearer ${'x'.repeat(48)}` } })).status, 404);
    const guest = (await (await fetch(`${s.baseUrl}/api/auth/guest`, { method: 'POST' })).json()).token;
    assert.equal((await fetch(`${s.baseUrl}/api/health/details`, { headers: { authorization: `Bearer ${guest}` } })).status, 404, 'a normal user is not an admin');
    const ok = await fetch(`${s.baseUrl}/api/health/details`, { headers: { authorization: `Bearer ${HEALTH_TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).system.heapUsedMb > 0);
  });

  test('a readiness flood triggers at most one real check per cache window, and probes are throttled per IP', async () => {
    const s = await startTestServer({ PROBE_RATE_LIMIT_PER_MIN: '200', READY_CACHE_MS: '2000' });
    cleanups.push(() => s.stop());
    const before = (await healthDetails(s.baseUrl)).readinessComputations;
    const t0 = performance.now();
    const codes = await Promise.all(Array.from({ length: 300 }, () => fetch(`${s.baseUrl}/api/ready`).then((r) => r.status)));
    const elapsedS = (performance.now() - t0) / 1000;
    const after = (await healthDetails(s.baseUrl)).readinessComputations;
    assert.ok(after - before <= Math.ceil(elapsedS / 2) + 1, `real readiness checks during the flood: ${after - before} in ${elapsedS.toFixed(2)} s`);
    // Token bucket: capacity 200 plus refill during the burst (200/min). The first CI run of this test assumed no
    // refill and failed with 201 successes on a slower runner; the bound below is the exact allowance.
    const allowed = 200 + Math.ceil(elapsedS * (200 / 60)) + 1;
    const ok = codes.filter((c) => c === 200).length;
    assert.ok(ok <= allowed && codes.includes(429), `${ok} x 200 (allowed ${allowed} in ${elapsedS.toFixed(2)} s), ${codes.filter((c) => c === 429).length} x 429`);
    const h = await Promise.all(Array.from({ length: 250 }, () => fetch(`${s.baseUrl}/api/health`).then((r) => r.status)));
    assert.ok(h.includes(429), 'liveness flood from one IP is throttled');
  });
});

describe('R-14: migrations have their own timeouts and can never be partially applied', { skip: pgSkip }, () => {
  const realMigrations = path.join(import.meta.dirname, '..', 'server', 'db', 'migrations');
  const migDir = (extra: Record<string, string>) => {
    const d = tmp('mig-');
    for (const f of fs.readdirSync(realMigrations)) fs.copyFileSync(path.join(realMigrations, f), path.join(d, f));
    for (const [name, sql] of Object.entries(extra)) fs.writeFileSync(path.join(d, name), sql);
    return d;
  };

  test('a migration longer than the request pool timeouts succeeds (request statement timeout 500 ms, migration takes 3 s)', async () => {
    const { migrate } = await import('../server/db/migrate.ts');
    const { createPool } = await import('../server/db/pool.ts');
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const prev = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '500'; // request pool: 500 ms server-side, 2.5 s client-side
    const pool = createPool(db.url, { max: 2 });
    if (prev === undefined) delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    else process.env.DATABASE_STATEMENT_TIMEOUT_MS = prev;
    cleanups.push(() => pool.end());
    await assert.rejects(pool.query('SELECT pg_sleep(1)'), 'the request pool really enforces its short timeout');
    const out = await migrate(pool, migDir({ '9001_slow_backfill.sql': 'SELECT pg_sleep(3);\nCREATE TABLE slow_ok (id int);' }));
    assert.ok(out.applied.includes('9001_slow_backfill.sql'));
    assert.equal((await pool.query("SELECT to_regclass('public.slow_ok') AS t")).rows[0].t, 'slow_ok');
  });

  test('a migration that times out leaves the schema unchanged (no partial state) and a fixed re-run recovers', async () => {
    const { migrate } = await import('../server/db/migrate.ts');
    const db = await createTestDatabase(); // already at the current schema
    cleanups.push(() => db.drop());
    const versionsBefore = (await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
    const dir = migDir({ '9001_a.sql': 'CREATE TABLE part_a (id int);', '9002_b.sql': 'CREATE TABLE part_b (id int);\nSELECT pg_sleep(2);' });
    await assert.rejects(migrate(db.pool, dir, { statementTimeoutMs: 500 }), /9002_b\.sql failed \(statement timeout\); nothing was applied/);
    assert.deepEqual((await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version), versionsBefore);
    assert.equal((await db.pool.query("SELECT to_regclass('public.part_a') AS t")).rows[0].t, null, '9001 rolled back with 9002 (all-or-nothing)');
    const ok = await migrate(db.pool, dir, { statementTimeoutMs: 10000 });
    assert.deepEqual(ok.applied, ['9001_a.sql', '9002_b.sql']);
  });

  test('a DDL migration that cannot get its table lock fails fast (lock timeout) instead of blocking traffic, and leaves nothing behind', async () => {
    const { migrate } = await import('../server/db/migrate.ts');
    const db = await createTestDatabase();
    cleanups.push(() => db.drop());
    const holder = await db.pool.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE projects IN ACCESS SHARE MODE'); // a long-running reader
    try {
      const dir = migDir({ '9001_alter.sql': 'ALTER TABLE projects ADD COLUMN archived boolean;' });
      await assert.rejects(migrate(db.pool, dir, { lockTimeoutMs: 300 }), /lock timeout/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const cols = (await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'archived'")).rows;
    assert.deepEqual(cols, []);
  });

  test('statements that cannot run in a transaction are rejected before anything is applied', async () => {
    const { migrate } = await import('../server/db/migrate.ts');
    const db = await createTestDatabase({ migrate: false });
    cleanups.push(() => db.drop());
    const dir = migDir({ '9001_idx.sql': 'CREATE INDEX CONCURRENTLY projects_title_idx ON projects (title);' });
    await assert.rejects(migrate(db.pool, dir), /cannot run inside the migration transaction/);
    assert.equal((await db.pool.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t, null, 'not even the bookkeeping table was created');
  });
});
