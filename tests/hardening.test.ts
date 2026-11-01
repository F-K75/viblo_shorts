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
