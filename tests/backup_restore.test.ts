// Backup / restore safety (PR #3 corrective round: F1, F2, F3) plus the failure matrix required for the gate:
// interrupted backup, corrupted backup, wrong key, partial restore, connection loss, non-empty target,
// repeated restore, recovery after process interruption, ownership/project preservation.
// Every database here is a throwaway test database; no real user data is involved.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createTestDatabase, pgSkip, type TestDb } from './helpers/pg.ts';
import { createBackup, listBackups, restoreBackup, type OffsiteConfig } from '../server/db/offsiteBackup.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const cleanups: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function ageKey() {
  const dir = tmp('br-age-');
  const file = path.join(dir, 'key.txt');
  execFileSync('age-keygen', ['-o', file], { stdio: 'ignore' });
  const pub = /public key: (age1\w+)/.exec(fs.readFileSync(file, 'utf8'))![1];
  return { file, pub };
}
async function db(migrated = true) {
  const d = await createTestDatabase({ migrate: migrated });
  cleanups.push(() => d.drop());
  return d;
}
const fileTarget = (): OffsiteConfig => ({ target: `file://${tmp('br-target-')}`, allowFileTarget: true });
const client = async (d: TestDb) => {
  const c = new pg.Client({ connectionString: d.url.replace(/[?&]sslmode=disable/, '') });
  c.on('error', () => {});
  await c.connect();
  return c;
};
async function q(d: TestDb, sql: string, params: any[] = []) {
  const c = await client(d);
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
const publicTables = async (d: TestDb) => Number((await q(d, "SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public'"))[0].n);

let seq = 0;
async function addProject(c: pg.Client, userId: string, kind: 'firebase' | 'guest', title: string) {
  const id = `proj_${crypto.randomBytes(8).toString('hex')}`;
  const doc = { id, userId, title, script: { beats: [{ text: `beat ${++seq}` }] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await c.query('INSERT INTO users (id, kind) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, kind]);
  await c.query('INSERT INTO projects (id, user_id, title, doc, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, now(), now())', [
    id,
    userId,
    title,
    JSON.stringify(doc),
    JSON.stringify(doc).length,
  ]);
}
async function seed(d: TestDb) {
  const c = await client(d);
  try {
    for (let i = 0; i < 6; i++) await addProject(c, 'firebase-alice', 'firebase', `alice ${i}`);
    for (let i = 0; i < 4; i++) await addProject(c, 'guest_' + 'b'.repeat(32), 'guest', `guest ${i}`);
    await addProject(c, 'firebase-carol', 'firebase', 'carol only');
  } finally {
    await c.end();
  }
}
const projectRows = (d: TestDb) => q(d, 'SELECT id, user_id, title, doc FROM projects ORDER BY id');

/** Writes a shell wrapper and points the tool override (e.g. PG_RESTORE_PATH) at it for the duration of fn. */
async function withTool<T>(envName: string, script: string, fn: () => Promise<T>): Promise<T> {
  const dir = tmp('br-tool-');
  const file = path.join(dir, 'tool.sh');
  fs.writeFileSync(file, `#!/bin/bash\nset -o pipefail\n${script}\n`, { mode: 0o755 });
  const prev = process.env[envName];
  process.env[envName] = file;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[envName];
    else process.env[envName] = prev;
  }
}

describe('F1: backup manifest is consistent with the dump under concurrent writes', { skip: pgSkip }, () => {
  test('a backup taken during a write storm restores with verified:true (3 runs)', async () => {
    const key = ageKey();
    for (let run = 0; run < 3; run++) {
      const src = await db();
      await seed(src);
      const cfg = fileTarget();
      const w = await client(src);
      let stop = false;
      let writes = 0;
      const writer = (async () => {
        while (!stop) {
          await addProject(w, `firebase-writer-${writes % 7}`, 'firebase', `w${writes}`);
          writes++;
        }
      })();
      await new Promise((r) => setTimeout(r, 150));
      const manifest = await createBackup(src.url, cfg, [key.pub]);
      stop = true;
      await writer;
      await w.end();
      const dst = await db(false);
      const report = await restoreBackup(cfg, manifest.name, dst.url, key.file);
      assert.ok(writes > 20, `the writer really ran during the backup (${writes} writes)`);
      assert.equal(report.verified, true, `manifest ${JSON.stringify(manifest.rowCounts)} vs restored ${JSON.stringify(report.rowCounts)}`);
      assert.equal(report.rowCounts.projects, manifest.rowCounts.projects);
    }
  });
});

describe('F2: a restore is applied completely or not at all', { skip: pgSkip }, () => {
  test('pg_restore dying midway leaves the target empty, and a repeated restore then succeeds', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dst = await db(false);
    // real pg_restore, cut after the schema and part of the data, then a non-zero exit
    await withTool('PG_RESTORE_PATH', 'pg_restore "$@" | head -c 6000; exit 7', async () => {
      await assert.rejects(restoreBackup(cfg, m.name, dst.url, key.file), /pg_restore|tool\.sh/);
    });
    assert.equal(await publicTables(dst), 0, 'nothing from the failed restore was committed');
    const ok = await restoreBackup(cfg, m.name, dst.url, key.file);
    assert.equal(ok.verified, true);
    assert.deepEqual(await projectRows(dst), await projectRows(src));
  });

  test('a corrupted backup whose checksum was also rewritten (decryption fails midway) leaves the target empty', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const c = await client(src);
    for (let i = 0; i < 400; i++) await addProject(c, 'firebase-bulk', 'firebase', crypto.randomBytes(400).toString('hex'));
    await c.end();
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dir = new URL(cfg.target).pathname;
    const blob = fs.readFileSync(path.join(dir, m.objectKey));
    blob[blob.length - 200] ^= 0xff; // corrupt the last chunk: earlier chunks decrypt and stream out first
    fs.writeFileSync(path.join(dir, m.objectKey), blob);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, `${m.name}.manifest.json`), 'utf8'));
    manifest.sha256 = crypto.createHash('sha256').update(blob).digest('hex'); // attacker/bit-rot also fixed the checksum
    fs.writeFileSync(path.join(dir, `${m.name}.manifest.json`), JSON.stringify(manifest));
    const dst = await db(false);
    await assert.rejects(restoreBackup(cfg, m.name, dst.url, key.file), /age/);
    assert.equal(await publicTables(dst), 0);
  });

  test('killing the restore orchestrator midway leaves the target empty; restarting the restore recovers', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const targetDir = tmp('br-cli-target-');
    const cfg: OffsiteConfig = { target: `file://${targetDir}`, allowFileTarget: true };
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dst = await db(false);
    const slow = path.join(tmp('br-slow-'), 'pg_restore.sh');
    // emit the schema and some data, then stall, so the process is killed while the restore is in flight
    // deliver every DDL statement up to (not including) the first COPY, i.e. a clean statement boundary, then stall
    fs.writeFileSync(slow, '#!/bin/bash\nf=$(mktemp)\npg_restore "$@" > "$f" || exit 1\nawk \'/^COPY /{exit} {print}\' "$f"\nsleep 30\nrm -f "$f"\n', { mode: 0o755 });
    // a separate restore process (the unit under test, not the CLI argument format), killed below
    const runner = path.join(tmp('br-runner-'), 'restore.mts');
    fs.writeFileSync(runner, `import { restoreBackup } from ${JSON.stringify(path.join(ROOT, 'server/db/offsiteBackup.ts'))};\nawait restoreBackup(JSON.parse(process.env.CFG), process.env.NAME, process.env.TARGET, process.env.KEY);\n`);
    const env = { ...process.env, CFG: JSON.stringify(cfg), NAME: m.name, TARGET: dst.url, KEY: key.file, PG_RESTORE_PATH: slow };
    const child = spawn(process.execPath, ['--import', 'tsx', runner], { cwd: ROOT, env, stdio: 'ignore' });
    // wait until the restore has created tables inside its (uncommitted) transaction
    for (let i = 0; i < 100; i++) {
      const n = await q(dst, "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'psql' AND state <> 'idle'");
      if (Number(n[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    // only the Node process dies (OOM kill, operator Ctrl-\\, host restart of the job runner). psql survives it and
    // sees end-of-input; it must not treat that as "restore complete".
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    for (let i = 0; i < 50 && Number((await q(dst, "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'psql'"))[0].n) > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await publicTables(dst), 0, 'an interrupted restore committed nothing');
    const ok = await restoreBackup(cfg, m.name, dst.url, key.file);
    assert.equal(ok.verified, true);
  });
});

describe('F3: the restore CLI never takes database credentials on the command line', { skip: pgSkip }, () => {
  test('a target URL in argv is refused; RESTORE_DATABASE_URL works', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dst = await db(false);
    const run = (args: string[], extra: Record<string, string>) =>
      new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const c = spawn(process.execPath, ['--import', 'tsx', 'scripts/db-backup.ts', ...args], {
          cwd: ROOT,
          env: { ...process.env, BACKUP_TARGET: cfg.target, BACKUP_ALLOW_FILE_TARGET: '1', BACKUP_AGE_IDENTITY_FILE: key.file, ...extra },
        });
        let stderr = '';
        c.stderr.on('data', (d) => (stderr += d));
        c.on('close', (status) => resolve({ status, stderr }));
      });
    const withPassword = new URL(dst.url);
    withPassword.password = 'pw-must-not-be-in-argv';
    const refused = await run(['restore', m.name, withPassword.toString()], {});
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /RESTORE_DATABASE_URL/);
    assert.ok(!refused.stderr.includes('pw-must-not-be-in-argv'), 'the error never echoes the credential');
    assert.equal(await publicTables(dst), 0, 'nothing was restored from the refused invocation');
    const ok = await run(['restore', m.name], { RESTORE_DATABASE_URL: dst.url });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(await projectRows(dst), await projectRows(src));
  });
});

describe('Backup/restore failure matrix', { skip: pgSkip }, () => {
  test('interrupted backup (pg_dump fails midway): error, no manifest, nothing listed', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    await withTool('PG_DUMP_PATH', 'pg_dump "$@" | head -c 3000; exit 9', async () => {
      await assert.rejects(createBackup(src.url, cfg, [key.pub]), /pg_dump|tool\.sh/);
    });
    assert.deepEqual(await listBackups(cfg), []);
    assert.deepEqual(fs.readdirSync(new URL(cfg.target).pathname), [], 'no ciphertext or manifest left in the target');
  });

  test('database connection lost during backup: error, nothing listed', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const c = await client(src);
    for (let i = 0; i < 300; i++) await addProject(c, 'firebase-bulk', 'firebase', crypto.randomBytes(2000).toString('hex'));
    await c.end();
    const cfg = fileTarget();
    // slow consumer: pg_dump blocks on the pipe while its connection is open; then that connection is killed
    await withTool('PG_DUMP_PATH', 'pg_dump "$@" | { sleep 2; cat; }', async () => {
      const p = createBackup(src.url, cfg, [key.pub]);
      for (let i = 0; i < 50; i++) {
        const r = await q(src, "SELECT pg_terminate_backend(pid) AS t FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'pg_dump'");
        if (r.length) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await assert.rejects(p);
    });
    assert.deepEqual(await listBackups(cfg), []);
  });

  test('corrupted backup (checksum mismatch) and wrong key are refused before anything is applied', async () => {
    const key = ageKey();
    const other = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dst = await db(false);
    await assert.rejects(restoreBackup(cfg, m.name, dst.url, other.file), /age/);
    assert.equal(await publicTables(dst), 0, 'wrong key: nothing applied');
    const file = path.join(new URL(cfg.target).pathname, m.objectKey);
    const blob = fs.readFileSync(file);
    blob[120] ^= 0x01;
    fs.writeFileSync(file, blob);
    await assert.rejects(restoreBackup(cfg, m.name, dst.url, key.file), /checksum mismatch/);
    assert.equal(await publicTables(dst), 0, 'corrupted: nothing applied');
  });

  test('database connection lost during restore: error, target empty, retry succeeds', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const dst = await db(false);
    await withTool('PG_RESTORE_PATH', 'pg_restore "$@" | { head -c 4000; sleep 2; cat; }', async () => {
      const p = restoreBackup(cfg, m.name, dst.url, key.file);
      for (let i = 0; i < 60; i++) {
        const r = await q(dst, "SELECT pg_terminate_backend(pid) AS t FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'psql'");
        if (r.length) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await assert.rejects(p);
    });
    assert.equal(await publicTables(dst), 0);
    assert.equal((await restoreBackup(cfg, m.name, dst.url, key.file)).verified, true);
  });

  test('a target that already holds user data is refused and left exactly as it was', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const live = await db();
    const c = await client(live);
    await addProject(c, 'firebase-live-user', 'firebase', 'live data must survive');
    await c.end();
    const before = await projectRows(live);
    await assert.rejects(restoreBackup(cfg, m.name, live.url, key.file), /non-empty database/);
    assert.deepEqual(await projectRows(live), before);
  });

  test('ownership and every project record survive a backup -> restore round trip, twice in a row', async () => {
    const key = ageKey();
    const src = await db();
    await seed(src);
    const cfg = fileTarget();
    const m = await createBackup(src.url, cfg, [key.pub]);
    const expected = await projectRows(src);
    const users = await q(src, 'SELECT id, kind, storage_bytes, project_count FROM users ORDER BY id');
    for (let i = 0; i < 2; i++) {
      const dst = await db(false);
      const r = await restoreBackup(cfg, m.name, dst.url, key.file);
      assert.equal(r.verified, true);
      assert.deepEqual(await projectRows(dst), expected);
      assert.deepEqual(await q(dst, 'SELECT id, kind, storage_bytes, project_count FROM users ORDER BY id'), users);
    }
  });
});
